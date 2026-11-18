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
else console.warn("omp-sandbox: no pid namespace here (unshare failed); 'full' containment tests are skipped");

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

	test("refuses a cwd outside the root or through a symlink", async () => {
		await rejectsWith(local.exec("true", { cwd: hostDir }), "OUTSIDE_ROOT");
		await fs.symlink(hostDir, path.join(sandboxDir, "to-host"));
		await rejectsWith(local.exec("true", { cwd: path.join(local.root, "to-host") }), "SYMLINK");
	});
});

describe("files", () => {
	test("write then read round-trips bytes and creates parent directories", async () => {
		const file = path.join(backend.root, "a/b/c.bin");
		const bytes = new Uint8Array([0, 1, 254, 255]);
		await backend.writeFile(file, bytes, { mode: 0o755 });
		expect(await backend.readFile(file)).toEqual(bytes);
		expect((await fs.stat(path.join(sandboxDir, "a/b/c.bin"))).mode & 0o777).toBe(0o755);
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
