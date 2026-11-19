import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BackendError, type BackendErrorCode } from "../src/backend.ts";
import { LocalBackend } from "../src/local-backend.ts";

let scratch: string;
let sandboxDir: string;
let hostDir: string;
let backend: LocalBackend;

beforeEach(async () => {
	scratch = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-test-"));
	sandboxDir = path.join(scratch, "sandbox");
	hostDir = path.join(scratch, "host");
	await fs.mkdir(sandboxDir);
	await fs.mkdir(hostDir);
	backend = await LocalBackend.create(sandboxDir);
});

afterEach(async () => {
	await backend.close();
	await fs.rm(scratch, { recursive: true, force: true });
});

/** Expect `promise` to reject with a BackendError carrying `code`. */
async function rejectsWith(promise: Promise<unknown>, code: BackendErrorCode): Promise<void> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(BackendError);
	expect(error instanceof BackendError ? error.code : undefined).toBe(code);
}

/** A `sleep` argument no other process on the host uses, to find our own processes. */
function uniqueSleep(): string {
	return `47.${randomInt(1e9)}`;
}

/** Host pids of live (non-zombie) processes whose command line contains `token`. */
function processesWith(token: string): number[] {
	const found: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			// A zombie's cmdline is empty, so only running processes match.
			if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(token)) found.push(Number(entry));
		} catch {
			// exited meanwhile
		}
	}
	return found;
}

/**
 * Waits until no process carries `token`; returns the survivors (empty when
 * all are gone). SIGKILL lands asynchronously in the kernel, so this polls the
 * process table with a deadline: it waits for the condition, not a guess. Any
 * survivor is killed so a failing test leaves nothing behind.
 */
async function survivorsOf(token: string, deadlineMs = 3_000): Promise<number[]> {
	const until = Date.now() + deadlineMs;
	for (;;) {
		const alive = processesWith(token);
		if (alive.length === 0 || Date.now() > until) {
			for (const pid of alive) process.kill(pid, "SIGKILL");
			return alive;
		}
		await Bun.sleep(20);
	}
}

const modes: { containment: LocalBackend["containment"] }[] = [{ containment: "process-tree" }];
const probe = await LocalBackend.create(os.tmpdir()).catch(() => undefined);
const fullSupported = probe?.containment === "full";
await probe?.close();
if (fullSupported) modes.push({ containment: "full" as const });
else {
	console.warn(
		"omp-sandbox: this host cannot create a user+pid namespace, so the 'full' containment tests are skipped. " +
			"Run them where unprivileged user namespaces are allowed, or in a throwaway VM or container.",
	);
}

// Whether this host can create a user+pid namespace at all, checked without
// LocalBackend's init. Where it can, "full" being unavailable is a
// LocalBackend bug (a broken init), not a host limit, and must fail instead
// of silently skipping the full-mode tests. Always with a user namespace, as
// LocalBackend does: never a real-root namespace.
const hostCanUnshare =
	Bun.spawnSync(["unshare", "--user", "--map-root-user", "--pid", "--fork", "--kill-child", "--", "true"]).exitCode === 0;
test.if(hostCanUnshare)("full containment is available wherever the host can create a pid namespace", () => {
	expect(fullSupported).toBe(true);
});

describe.each(modes)("exec, containment $containment", ({ containment }) => {
	let local: LocalBackend;
	beforeEach(async () => {
		local = await LocalBackend.create(sandboxDir, { containment });
	});
	afterEach(async () => {
		await local.close();
	});

	test("runs in the given cwd and reports stdout, stderr and the exit code separately", async () => {
		await fs.mkdir(path.join(sandboxDir, "sub"));
		const result = await local.exec("pwd; echo oops >&2; exit 3", { cwd: path.join(local.root, "sub") });
		expect(result.stdout).toBe(`${path.join(local.root, "sub")}\n`);
		expect(result.stderr).toBe("oops\n");
		expect(result.exitCode).toBe(3);
		expect(result.signal).toBeNull();
		expect(result.timedOut || result.aborted || result.truncated).toBe(false);
	});

	test("starts from a minimal environment, never the host's", async () => {
		process.env.OMP_SANDBOX_HOST_SECRET = "must-not-leak";
		try {
			const result = await local.exec('echo "[$OMP_SANDBOX_HOST_SECRET][$EXTRA][$HOME]"', {
				cwd: local.root,
				env: { EXTRA: "given" },
			});
			expect(result.stdout).toBe(`[][given][${local.root}]\n`);
		} finally {
			delete process.env.OMP_SANDBOX_HOST_SECRET;
		}
	});

	test("an environment entry named __proto__ is passed like any other", async () => {
		const result = await local.exec("printenv __proto__", { cwd: local.root, env: JSON.parse('{"__proto__":"sentinel"}') });
		expect(result.stdout).toBe("sentinel\n");
		expect(result.exitCode).toBe(0);
	});

	test("a command that cannot be started leaves no temporary files behind", async () => {
		// os.tmpdir() follows TMPDIR, so the status directory lands somewhere observable.
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-tmpdir-"));
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = tmp;
		try {
			// One argument above the kernel's 128 KiB limit: spawn fails with E2BIG.
			await expect(local.exec(`: ${"x".repeat(200_000)}`, { cwd: local.root })).rejects.toThrow();
			expect(await fs.readdir(tmp)).toEqual([]);
		} finally {
			if (saved === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = saved;
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	test("streams output in arrival order", async () => {
		const chunks: string[] = [];
		// The sleeps run inside the command, so each line arrives as its own chunk.
		await local.exec("echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three", {
			cwd: local.root,
			onOutput: (chunk, stream) => chunks.push(`${stream}:${chunk}`),
		});
		expect(chunks).toEqual(["stdout:one\n", "stderr:two\n", "stdout:three\n"]);
	});

	test("a timeout kills descendants, including ones that left the process group", async () => {
		const plain = uniqueSleep();
		const escaped = uniqueSleep();
		const started = Date.now();
		// timeoutMs is the real-time behaviour under test, so a real clock is needed.
		const result = await local.exec(`sleep ${plain} & setsid sleep ${escaped} & wait`, {
			cwd: local.root,
			timeoutMs: 300,
		});
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(result.signal).toBe("SIGKILL");
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await survivorsOf(plain)).toEqual([]);
		expect(await survivorsOf(escaped)).toEqual([]);
	});

	test("aborting kills descendants, including ones that left the process group", async () => {
		const escaped = uniqueSleep();
		const controller = new AbortController();
		// "started" comes from the escaped process itself, after setsid, so the
		// abort lands only once it has really left the process group.
		const result = await local.exec(`setsid bash -c 'echo started; exec sleep ${escaped}' & wait`, {
			cwd: local.root,
			signal: controller.signal,
			onOutput: () => controller.abort(),
		});
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(await survivorsOf(escaped)).toEqual([]);
	});

	test("an already-aborted signal never starts the command", async () => {
		const controller = new AbortController();
		controller.abort();
		const marker = path.join(sandboxDir, "ran");
		const result = await local.exec(`touch ${marker}`, { cwd: local.root, signal: controller.signal });
		expect(result.aborted).toBe(true);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test("stops capturing at maxOutputBytes without cutting a UTF-8 character", async () => {
		const result = await local.exec("printf 'ééééé'; printf 'zz' >&2", { cwd: local.root, maxOutputBytes: 5 });
		expect(result.truncated).toBe(true);
		expect(result.stdout).toBe("éé");
		expect(result.stderr).toBe("zz");
	});

	test("returns promptly even if a background process keeps the pipes open", async () => {
		const token = uniqueSleep();
		const started = Date.now();
		const result = await local.exec(`sleep ${token} & echo done`, { cwd: local.root });
		await survivorsOf(token, 0); // clean up in process-tree mode
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("done\n");
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	test.if(containment === "full")("processes left running when the shell exits are killed", async () => {
		const escaped = uniqueSleep();
		const result = await local.exec(`setsid sleep ${escaped} & echo started`, { cwd: local.root });
		expect(result.exitCode).toBe(0);
		expect(await survivorsOf(escaped)).toEqual([]);
	});

	test.if(containment === "full")("full containment runs in its own user namespace, never as real root", async () => {
		const host = await fs.readlink("/proc/self/ns/user");
		const result = await local.exec("readlink /proc/self/ns/user", { cwd: local.root });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toMatch(/^user:\[\d+\]$/);
		expect(result.stdout.trim()).not.toBe(host);
	});

	test("a command ended by a signal reports that signal, with nothing added to stderr", async () => {
		const result = await local.exec("kill -TERM $$", { cwd: local.root });
		expect(result.exitCode).toBeNull();
		expect(result.signal).toBe("SIGTERM");
		expect(result.stderr).toBe("");
		expect(result.timedOut || result.aborted).toBe(false);
	});

	test("an exit status above 128 is an exit code, not a signal", async () => {
		const result = await local.exec("exit 143", { cwd: local.root });
		expect(result.exitCode).toBe(143);
		expect(result.signal).toBeNull();
	});

	test("the command sees default signal dispositions (SIGPIPE ends it)", async () => {
		const raised = await local.exec("kill -PIPE $$; echo survived", { cwd: local.root });
		expect(raised.signal).toBe("SIGPIPE");
		expect(raised.exitCode).toBeNull();
		expect(raised.stdout).toBe("");

		const pipe = await local.exec("set -o pipefail; yes | head -n 1", { cwd: local.root });
		expect(pipe.stdout).toBe("y\n");
		expect(pipe.exitCode).toBe(141); // yes died of SIGPIPE; the pipeline reports 128+13
		expect(pipe.stderr).toBe("");
	});

	test("an inherited fd 3 is not a channel: writing to it does not fake a signal", async () => {
		const result = await local.exec("echo 15 >&3", { cwd: local.root });
		expect(result.exitCode).toBe(1);
		expect(result.signal).toBeNull();
	});

	test.if(containment === "full")("the report file is removed after every command", async () => {
		const before = (await fs.readdir(os.tmpdir())).filter(n => n.startsWith("omp-sandbox-status-")).length;
		await local.exec("kill -TERM $$", { cwd: local.root });
		await local.exec("true", { cwd: local.root });
		const after = (await fs.readdir(os.tmpdir())).filter(n => n.startsWith("omp-sandbox-status-")).length;
		expect(after).toBe(before);
	});

	test("refuses a cwd outside the root or through a symlink", async () => {
		await rejectsWith(local.exec("true", { cwd: hostDir }), "OUTSIDE_ROOT");
		await fs.symlink(hostDir, path.join(sandboxDir, "to-host"));
		await rejectsWith(local.exec("true", { cwd: path.join(local.root, "to-host") }), "SYMLINK");
	});
});

/**
 * Runs test/fixtures/list-recursive.ts on `root` as an unprivileged user, where
 * directory permissions apply. As root it runs as nobody (uid 65534) from a
 * copy that user can read; otherwise as the current user.
 */
async function listRecursiveUnprivileged(root: string): Promise<unknown> {
	const fixture = path.join(import.meta.dir, "fixtures/list-recursive.ts");
	let argv = [process.execPath, fixture, root];
	let env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: scratch };
	// The fixture runs from the scratch dir, never the checkout, which the
	// unprivileged user may not be able to enter.
	let cwd = scratch;
	if (process.getuid?.() === 0) {
		const code = path.join(scratch, "code");
		await fs.mkdir(path.join(code, "src"), { recursive: true });
		await fs.mkdir(path.join(code, "test/fixtures"), { recursive: true });
		for (const file of ["src/backend.ts", "src/local-backend.ts", "test/fixtures/list-recursive.ts"]) {
			await fs.copyFile(path.join(import.meta.dir, "..", file), path.join(code, file));
		}
		await fs.chmod(scratch, 0o755);
		expect(Bun.spawnSync(["chown", "-R", "65534:65534", code, root]).exitCode).toBe(0);
		argv = ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "--", process.execPath, path.join(code, "test/fixtures/list-recursive.ts"), root];
		env = { PATH: "/usr/bin:/bin", HOME: code, TMPDIR: code };
		cwd = code;
	}
	const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`fixture exited ${code}: ${err}`);
	return JSON.parse(out);
}

describe("files", () => {
	test("write then read round-trips bytes and creates parent directories", async () => {
		const file = path.join(backend.root, "a/b/c.bin");
		const bytes = new Uint8Array([0, 1, 254, 255]);
		await backend.writeFile(file, bytes, { mode: 0o755 });
		expect(await backend.readFile(file)).toEqual(bytes);
		expect((await fs.stat(path.join(sandboxDir, "a/b/c.bin"))).mode & 0o777).toBe(0o755);
	});

	test("a recursive list fails on a subdirectory it cannot open instead of dropping it", async () => {
		await fs.mkdir(path.join(sandboxDir, "private/leaf"), { recursive: true });
		await fs.writeFile(path.join(sandboxDir, "visible"), "");
		await fs.chmod(path.join(sandboxDir, "private"), 0o000);
		try {
			expect(await listRecursiveUnprivileged(sandboxDir)).toEqual({ error: "EACCES" });
		} finally {
			await fs.chmod(path.join(sandboxDir, "private"), 0o755);
		}
	});

	test("a rewrite without mode keeps the existing mode", async () => {
		const file = path.join(backend.root, "run.sh");
		await backend.writeFile(file, "#!/bin/sh\n", { mode: 0o755 });
		await backend.writeFile(file, "#!/bin/sh\necho hi\n");
		expect((await fs.stat(path.join(sandboxDir, "run.sh"))).mode & 0o777).toBe(0o755);
		expect(new TextDecoder().decode(await backend.readFile(file))).toBe("#!/bin/sh\necho hi\n");
	});

	test("missing files, directories and special files give typed errors", async () => {
		await rejectsWith(backend.readFile(path.join(backend.root, "nope")), "ENOENT");
		await fs.mkdir(path.join(sandboxDir, "dir"));
		await rejectsWith(backend.readFile(path.join(backend.root, "dir")), "EISDIR");
		await rejectsWith(backend.readFile(backend.root), "EISDIR");
		await rejectsWith(backend.writeFile(path.join(backend.root, "dir"), "x"), "EISDIR");
		expect(await backend.stat(path.join(backend.root, "nope"))).toBeNull();
		expect(await backend.stat(path.join(backend.root, "nope/deeper"))).toBeNull();
		const mkfifo = Bun.spawnSync(["mkfifo", path.join(sandboxDir, "fifo")]);
		expect(mkfifo.exitCode).toBe(0);
		await rejectsWith(backend.readFile(path.join(backend.root, "fifo")), "NOT_REGULAR");
		await rejectsWith(backend.writeFile(path.join(backend.root, "fifo"), "x"), "NOT_REGULAR");
	});

	test("stat reports the type without following a final symlink", async () => {
		await fs.writeFile(path.join(sandboxDir, "f.txt"), "hello");
		await fs.symlink("f.txt", path.join(sandboxDir, "link"));
		const file = await backend.stat(path.join(backend.root, "f.txt"));
		expect(file?.type).toBe("file");
		expect(file?.size).toBe(5);
		expect((await backend.stat(path.join(backend.root, "link")))?.type).toBe("symlink");
		expect((await backend.stat(backend.root))?.type).toBe("dir");
	});

	test("list is sorted by full path in byte order, so a limit keeps the sorted prefix", async () => {
		await fs.mkdir(path.join(sandboxDir, "a"));
		await fs.writeFile(path.join(sandboxDir, "a/z"), "");
		await fs.writeFile(path.join(sandboxDir, "a.txt"), "");
		await fs.writeFile(path.join(sandboxDir, "B"), "");
		const rel = (entries: { path: string }[]) => entries.map(e => path.relative(backend.root, e.path));
		expect(rel((await backend.list(backend.root)).entries)).toEqual(["B", "a", "a.txt"]);
		const all = await backend.list(backend.root, { recursive: true });
		// "." (0x2e) sorts before "/" (0x2f): a.txt comes before a/z.
		expect(rel(all.entries)).toEqual(["B", "a", "a.txt", "a/z"]);
		expect(all.truncated).toBe(false);
		const cut = await backend.list(backend.root, { recursive: true, limit: 3 });
		expect(rel(cut.entries)).toEqual(["B", "a", "a.txt"]);
		expect(cut.truncated).toBe(true);
	});
});

describe("tree sync: changes, pull, push, remove", () => {
	const bytes = (text: string) => new TextEncoder().encode(text);

	test("an edit that keeps size and mtime is reported even within the clock tick of the last token", async () => {
		// ctime moves on a coarse clock: most back-to-back edits here leave size,
		// mtime, ctime and inode all equal. Each one must still be reported.
		const file = path.join(sandboxDir, "same.txt");
		await fs.writeFile(file, "a0");
		let token = (await backend.changes()).token;
		for (let i = 1; i <= 20; i++) {
			await fs.writeFile(file, `a${i % 10}`);
			await fs.utimes(file, 1_000_000_000, 1_000_000_000);
			const next = await backend.changes(token);
			expect(next.changed.map(e => e.path)).toContain("same.txt");
			token = next.token;
		}
		// Once the file is older than the racy window, an unchanged one is not reported again.
		await Bun.sleep(1100);
		const settled = await backend.changes(token);
		await Bun.sleep(1100);
		expect((await backend.changes(settled.token)).changed).toEqual([]);
	});

	test("changes lists the whole tree first, then only what changed, with exact deletes; .git is never listed", async () => {
		await fs.writeFile(path.join(sandboxDir, "a.txt"), "a");
		await fs.mkdir(path.join(sandboxDir, "d"));
		await fs.writeFile(path.join(sandboxDir, "d/b.txt"), "b");
		await fs.mkdir(path.join(sandboxDir, ".git"));
		await fs.writeFile(path.join(sandboxDir, ".git/HEAD"), "ref");
		await fs.symlink("/etc/passwd", path.join(sandboxDir, "link"));
		const first = await backend.changes();
		expect(first.full).toBe(true);
		expect(first.changed.map(e => `${e.path}:${e.type}`)).toEqual(["a.txt:file", "d:dir", "d/b.txt:file", "link:symlink"]);

		await new Promise(resolve => setTimeout(resolve, 20));
		await fs.writeFile(path.join(sandboxDir, "a.txt"), "a2");
		await fs.rm(path.join(sandboxDir, "d"), { recursive: true });
		await fs.writeFile(path.join(sandboxDir, ".git/HEAD"), "moved");
		const second = await backend.changes(first.token);
		expect(second.full).toBe(false);
		// a.txt changed; entries written in the same second may be listed again (never fewer).
		expect(second.changed.map(e => e.path)).toContain("a.txt");
		expect(second.changed.map(e => e.path)).not.toContain("d/b.txt");
		expect(second.deleted).toEqual(["d", "d/b.txt"]);

		const unknown = await backend.changes("not-a-token");
		expect(unknown.full).toBe(true);
		expect(unknown.deleted).toEqual([]);
	});

	test("push writes files with their modes and creates parents; pull reads them back; neither leaves temp files", async () => {
		await backend.push([
			{ path: "x/y/run.sh", mode: 0o755, data: bytes("#!/bin/sh\n") },
			{ path: "plain.txt", mode: 0o644, data: bytes("p") },
		]);
		expect((await fs.stat(path.join(sandboxDir, "x/y/run.sh"))).mode & 0o777).toBe(0o755);
		const pulled = await backend.pull(["x/y/run.sh", "plain.txt", "missing.txt", "x"]);
		expect(pulled.map(f => [f.path, f.mode, new TextDecoder().decode(f.data)])).toEqual([
			["x/y/run.sh", 0o755, "#!/bin/sh\n"],
			["plain.txt", 0o644, "p"],
		]);
		expect((await fs.readdir(sandboxDir, { recursive: true })).sort()).toEqual(["plain.txt", "x", "x/y", "x/y/run.sh"]);
	});

	test("push refuses to replace a symlink or a directory, and never writes through a symlinked parent", async () => {
		await fs.writeFile(path.join(hostDir, "target.txt"), "host");
		await fs.symlink(path.join(hostDir, "target.txt"), path.join(sandboxDir, "file-link"));
		await fs.symlink(hostDir, path.join(sandboxDir, "dir-link"));
		await fs.mkdir(path.join(sandboxDir, "adir"));
		await rejectsWith(backend.push([{ path: "file-link", mode: 0o644, data: bytes("x") }]), "SYMLINK");
		await rejectsWith(backend.push([{ path: "dir-link/planted.txt", mode: 0o644, data: bytes("x") }]), "SYMLINK");
		await rejectsWith(backend.push([{ path: "adir", mode: 0o644, data: bytes("x") }]), "EISDIR");
		expect(await fs.readdir(hostDir)).toEqual(["target.txt"]);
		expect(await fs.readFile(path.join(hostDir, "target.txt"), "utf8")).toBe("host");
	});

	test("pull does not follow symlinks, and remove unlinks the symlink, never its target", async () => {
		await fs.writeFile(path.join(hostDir, "secret.txt"), "host");
		await fs.symlink(path.join(hostDir, "secret.txt"), path.join(sandboxDir, "s"));
		await fs.symlink(hostDir, path.join(sandboxDir, "sd"));
		expect(await backend.pull(["s", "sd/secret.txt"])).toEqual([]);
		await backend.remove(["s", "sd/secret.txt", "sd"]);
		expect(await fs.readdir(sandboxDir)).toEqual([]);
		expect(await fs.readFile(path.join(hostDir, "secret.txt"), "utf8")).toBe("host");
	});

	test("remove keeps a directory that still has content, and ignores paths already gone", async () => {
		await fs.mkdir(path.join(sandboxDir, "full"));
		await fs.writeFile(path.join(sandboxDir, "full/kept.txt"), "k");
		await fs.mkdir(path.join(sandboxDir, "empty"));
		await backend.remove(["full", "empty", "never-existed", "nope/deeper"]);
		expect((await fs.readdir(sandboxDir, { recursive: true })).sort()).toEqual(["full", "full/kept.txt"]);
	});

	test("workspace paths with empty, . or .. components, or absolute ones, are refused", async () => {
		for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a"]) {
			await rejectsWith(backend.push([{ path: bad, mode: 0o644, data: bytes("x") }]), "INVALID_PATH");
			await rejectsWith(backend.pull([bad]), "INVALID_PATH");
			await rejectsWith(backend.remove([bad]), "INVALID_PATH");
		}
		expect(await fs.readdir(scratch)).toEqual(expect.arrayContaining(["host", "sandbox"]));
		expect(await fs.readdir(scratch)).toHaveLength(2);
	});
});

describe("confinement: file operations never reach the host", () => {
	test("absolute host paths, .. escapes and relative paths are refused", async () => {
		await fs.writeFile(path.join(hostDir, "secret"), "host data");
		await rejectsWith(backend.readFile(path.join(hostDir, "secret")), "OUTSIDE_ROOT");
		await rejectsWith(backend.readFile(path.join(backend.root, "../host/secret")), "OUTSIDE_ROOT");
		await rejectsWith(backend.writeFile(path.join(hostDir, "planted"), "x"), "OUTSIDE_ROOT");
		await rejectsWith(backend.list(hostDir), "OUTSIDE_ROOT");
		await rejectsWith(backend.readFile("relative/path"), "INVALID_PATH");
		expect(await fs.readdir(hostDir)).toEqual(["secret"]);
	});

	test("no symlink is followed, inside or outside the root", async () => {
		await fs.writeFile(path.join(hostDir, "secret"), "host data");
		await fs.writeFile(path.join(sandboxDir, "inner.txt"), "inside");
		await fs.symlink(path.join(hostDir, "secret"), path.join(sandboxDir, "to-secret"));
		await fs.symlink(hostDir, path.join(sandboxDir, "to-host"));
		await fs.symlink("inner.txt", path.join(sandboxDir, "to-inner"));
		await rejectsWith(backend.readFile(path.join(backend.root, "to-secret")), "SYMLINK");
		await rejectsWith(backend.readFile(path.join(backend.root, "to-host/secret")), "SYMLINK");
		await rejectsWith(backend.readFile(path.join(backend.root, "to-inner")), "SYMLINK");
		await rejectsWith(backend.stat(path.join(backend.root, "to-host/secret")), "SYMLINK");
		await rejectsWith(backend.list(path.join(backend.root, "to-host")), "SYMLINK");
	});

	test("a write through a dangling symlink does not create the target", async () => {
		await fs.symlink(path.join(hostDir, "absent"), path.join(sandboxDir, "dangling"));
		await rejectsWith(backend.writeFile(path.join(backend.root, "dangling"), "x"), "SYMLINK");
		expect(await fs.readdir(hostDir)).toEqual([]);
	});

	test("a write through a symlinked parent creates nothing outside, not even directories", async () => {
		await fs.symlink(hostDir, path.join(sandboxDir, "to-host"));
		await rejectsWith(backend.writeFile(path.join(backend.root, "to-host/planted"), "x"), "SYMLINK");
		await rejectsWith(backend.writeFile(path.join(backend.root, "to-host/new/deep"), "x"), "SYMLINK");
		expect(await fs.readdir(hostDir)).toEqual([]);
	});

	test("a recursive list does not enter a symlinked directory", async () => {
		await fs.writeFile(path.join(hostDir, "secret"), "host data");
		await fs.symlink(hostDir, path.join(sandboxDir, "to-host"));
		const all = await backend.list(backend.root, { recursive: true });
		expect(all.entries.map(e => path.relative(backend.root, e.path))).toEqual(["to-host"]);
		expect(all.entries[0]?.type).toBe("symlink");
	});

	test("concurrently swapping a directory for a host symlink never redirects an operation", async () => {
		// Real concurrency is the point: a helper process atomically exchanges
		// sandbox/d (a real directory) with sandbox/d2 (a symlink to the host)
		// via renameat2(RENAME_EXCHANGE) for the whole run.
		await fs.mkdir(path.join(sandboxDir, "d"));
		await fs.writeFile(path.join(sandboxDir, "d/f"), "inside");
		await fs.writeFile(path.join(hostDir, "f"), "HOST");
		await fs.writeFile(path.join(hostDir, "hostonly"), "HOST");
		await fs.symlink(hostDir, path.join(sandboxDir, "d2"));
		const swapper = Bun.spawn(
			[
				"python3",
				"-c",
				"import ctypes,sys,time\nlibc=ctypes.CDLL(None,use_errno=True)\nn=0\nend=time.time()+float(sys.argv[3])\nwhile time.time()<end:\n  n+=libc.renameat2(-100,sys.argv[1].encode(),-100,sys.argv[2].encode(),2)==0\nprint(n)",
				path.join(sandboxDir, "d"),
				path.join(sandboxDir, "d2"),
				"1.5",
			],
			{ stdout: "pipe" },
		);
		const escapes: string[] = [];
		let reads = 0;
		let writes = 0;
		const until = Date.now() + 1_400;
		for (let i = 0; Date.now() < until; i++) {
			const d = path.join(backend.root, "d");
			const content = await backend.readFile(path.join(d, "f")).catch(() => undefined);
			if (content !== undefined) {
				reads++;
				if (new TextDecoder().decode(content) !== "inside") escapes.push("read host file");
			}
			if (await backend.writeFile(path.join(d, `w${i}`), "x").then(() => true, () => false)) writes++;
			const listed = await backend.list(d).catch(() => undefined);
			if (listed?.entries.some(e => e.path.endsWith("/hostonly"))) escapes.push("listed host dir");
			if ((await backend.stat(path.join(d, "hostonly")).catch(() => null)) !== null) escapes.push("stat host file");
		}
		const swaps = Number((await new Response(swapper.stdout).text()).trim());
		expect(await swapper.exited).toBe(0);
		expect(escapes).toEqual([]);
		expect((await fs.readdir(hostDir)).sort()).toEqual(["f", "hostonly"]);
		// Positive controls: the swapper ran, and operations did succeed meanwhile.
		expect(swaps).toBeGreaterThan(100);
		expect(reads).toBeGreaterThan(0);
		expect(writes).toBeGreaterThan(0);
	});
});

/** Runs a Backend.shellCommand line the way a host shell would, from an unrelated cwd. */
async function runLine(line: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["/bin/bash", "-c", line], { cwd: os.tmpdir(), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
}

describe.each(modes)("shellCommand, containment $containment", ({ containment }) => {
	let local: LocalBackend;
	beforeEach(async () => {
		local = await LocalBackend.create(sandboxDir, { containment });
	});
	afterEach(async () => {
		await local.close();
	});

	test("runs in the sandbox cwd with the sandbox environment, never the host's", async () => {
		await fs.mkdir(path.join(sandboxDir, "sub"));
		process.env.OMP_SANDBOX_HOST_SECRET = "must-not-leak";
		try {
			const line = local.shellCommand('pwd; echo "[$OMP_SANDBOX_HOST_SECRET][$EXTRA][$HOME]"', {
				cwd: path.join(local.root, "sub"),
				env: { EXTRA: "given" },
			});
			const result = await runLine(line);
			expect(result.stdout).toBe(`${path.join(local.root, "sub")}\n[][given][${local.root}]\n`);
			expect(result.code).toBe(0);
		} finally {
			delete process.env.OMP_SANDBOX_HOST_SECRET;
		}
	});

	test("an environment entry named __proto__ is passed like any other", async () => {
		const result = await runLine(local.shellCommand("printenv __proto__", { cwd: local.root, env: JSON.parse('{"__proto__":"sentinel"}') }));
		expect(result.stdout).toBe("sentinel\n");
		expect(result.code).toBe(0);
	});

	test("passes the command through literally and reports its exit code and stderr", async () => {
		const result = await runLine(local.shellCommand(`echo 'it'"'"'s $HOME' "\\$x"; echo oops >&2; exit 3`, { cwd: local.root }));
		expect(result.stdout).toBe(`it's $HOME $x\n`);
		expect(result.stderr).toBe("oops\n");
		expect(result.code).toBe(3);
	});

	test("a command ended by a signal exits 128+n, with nothing added to stderr", async () => {
		const result = await runLine(local.shellCommand("kill -TERM $$", { cwd: local.root }));
		expect(result.code).toBe(143);
		expect(result.stderr).toBe("");
	});

	test("starts with an absolute program path, never cd or a bare name", () => {
		const line = local.shellCommand("cd sub && make", { cwd: local.root });
		expect(line.startsWith("/usr/bin/env ")).toBe(true);
	});

	test("refuses a cwd outside the root and invalid environment names", () => {
		expect(() => local.shellCommand("true", { cwd: hostDir })).toThrow(BackendError);
		expect(() => local.shellCommand("true", { cwd: local.root, env: { "BAD-NAME": "x" } })).toThrow(BackendError);
		expect(() => local.shellCommand("true", { cwd: local.root, env: { OK: "a\0b" } })).toThrow(BackendError);
	});

	test.if(containment === "full")("killing the line's process kills everything the command started", async () => {
		const escaped = uniqueSleep();
		const child = Bun.spawn(["/bin/bash", "-c", local.shellCommand(`setsid sleep ${escaped} & echo started; wait`, { cwd: local.root })], {
			cwd: os.tmpdir(),
			stdout: "pipe",
			detached: true,
		});
		const reader = child.stdout.getReader();
		const first = await reader.read(); // "started": the escaped sleep exists
		expect(new TextDecoder().decode(first.value)).toContain("started");
		// The caller kills the process group it started, as omp's bash does.
		process.kill(-child.pid, "SIGKILL");
		await child.exited;
		expect(await survivorsOf(escaped)).toEqual([]);
	});
});
