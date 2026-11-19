// GitmootBackend against a fake gitmoot CLI that follows the pinned contract
// (test/fixtures/fake-gitmoot.sh). Proves the command line the backend builds
// for omp's bash; the real CLI replaces the fake once it exists.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BackendError } from "../src/backend.ts";
import { GitmootBackend, GitmootCliError } from "../src/gitmoot-backend.ts";
import { Mirror } from "../src/mirror.ts";

const FAKE = path.join(import.meta.dir, "fixtures/fake-gitmoot.sh");
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-gitmoot-")));
	await fs.mkdir(path.join(root, "sub dir"));
	saved = { root: process.env.FAKE_GITMOOT_ROOT, state: process.env.FAKE_GITMOOT_STATE };
	process.env.FAKE_GITMOOT_ROOT = root;
	delete process.env.FAKE_GITMOOT_STATE;
});

afterEach(async () => {
	for (const [key, name] of [["root", "FAKE_GITMOOT_ROOT"], ["state", "FAKE_GITMOOT_STATE"]] as const) {
		if (saved[key] === undefined) delete process.env[name];
		else process.env[name] = saved[key];
	}
	await fs.rm(root, { recursive: true, force: true });
});

/** Runs a shellCommand line the way omp's bash would: through a host shell. */
async function runLine(line: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["/bin/bash", "-c", line], {
		cwd: os.tmpdir(),
		env: { PATH: "/usr/bin:/bin", FAKE_GITMOOT_ROOT: root, HOST_SECRET: "must-not-leak" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
}

describe("GitmootBackend", () => {
	test("open reads the workspace's root from `workspace show`", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		expect(backend.root).toBe(root);
		expect(backend.containment).toBe("process-group");
	});

	test("open refuses a workspace that is not ready, and reports the CLI's own errors", async () => {
		process.env.FAKE_GITMOOT_STATE = "opening";
		await expect(GitmootBackend.open({ bin: FAKE, workspace: "ws-test" })).rejects.toThrow(/is opening, not ready/);
		delete process.env.FAKE_GITMOOT_STATE;
		const error = await GitmootBackend.open({ bin: FAKE, workspace: "ws-other" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitmootCliError);
		expect((error as GitmootCliError).code).toBe("not_found");
	});

	test("the shell line runs the command in the workspace, in the given cwd, without the host environment", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		const result = await runLine(backend.shellCommand('pwd; echo "secret=[$HOST_SECRET]"; echo "extra=[$EXTRA]"', { cwd: path.join(root, "sub dir"), env: { EXTRA: "it's given" } }));
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(`${path.join(root, "sub dir")}\nsecret=[]\nextra=[it's given]\n`);
	});

	test("the shell line passes the command through literally and keeps its exit status", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		const result = await runLine(backend.shellCommand(`echo 'it'"'"'s $HOME' "\\$x"; echo oops >&2; exit 3`, { cwd: root }));
		expect(result.stdout).toBe("it's $HOME $x\n");
		expect(result.stderr).toBe("oops\n");
		expect(result.code).toBe(3);
	});

	test("the shell line uses absolute program paths and does not start with cd", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		const line = backend.shellCommand("true", { cwd: root });
		expect(line.startsWith("/usr/bin/env ")).toBe(true);
		expect(line).toContain(`'${FAKE}' ws sh`);
	});

	test("the fake CLI's status file tells a command's own 125 from a gitmoot failure (WORKSPACES.md)", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		const statusFile = path.join(root, "status.json");
		const line = backend.shellCommand("exit 125", { cwd: root }).replace(" ws sh ", ` ws sh --status-file '${statusFile}' `);
		expect((await runLine(line)).code).toBe(125);
		expect(JSON.parse(await fs.readFile(statusFile, "utf8"))).toEqual({ exit_code: 125, signal: null, timed_out: false, error: null });
		const outside = backend.shellCommand("true", { cwd: root }).replace("--cwd '.'", `--status-file '${statusFile}' --cwd '../x'`);
		expect((await runLine(outside)).code).toBe(125);
		expect(JSON.parse(await fs.readFile(statusFile, "utf8")).error.code).toBe("cwd_outside_root");
	});

	test("a cwd outside the root and an invalid environment name are refused before anything runs", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		for (const cwd of ["/etc", `${root}/..`, `${root}-other`]) {
			expect(() => backend.shellCommand("true", { cwd })).toThrow(BackendError);
		}
		expect(() => backend.shellCommand("true", { cwd: root, env: { "BAD-NAME": "x" } })).toThrow(BackendError);
	});

	test("exec runs bash in the workspace and reports stdout, stderr and the exit code apart, without the host environment", async () => {
		process.env.HOST_SECRET = "must-not-leak";
		try {
			const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
			const chunks: string[] = [];
			const result = await backend.exec('pwd; echo "e=[$EXTRA] s=[${HOST_SECRET-}]"; echo oops >&2; exit 4', {
				cwd: path.join(root, "sub dir"),
				env: { EXTRA: "it's x" },
				onOutput: chunk => chunks.push(chunk),
			});
			expect(result).toMatchObject({ exitCode: 4, signal: null, stdout: `${path.join(root, "sub dir")}\ne=[it's x] s=[]\n`, stderr: "oops\n", timedOut: false, aborted: false });
			expect(chunks.join("")).toContain("e=[it's x]");
		} finally {
			delete process.env.HOST_SECRET;
		}
	});

	test("exec's timeout ends the whole command group and reports the signal", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		const started = Date.now();
		const result = await backend.exec(`(sleep 30; touch ${path.join(root, "late")}) & sleep 30`, { cwd: root, timeoutMs: 500 });
		expect(result.timedOut).toBe(true);
		expect(result.signal).toBe("SIGTERM");
		expect(result.exitCode).toBeNull();
		expect(Date.now() - started).toBeLessThan(10_000);
		await Bun.sleep(500);
		expect(await Bun.file(path.join(root, "late")).exists()).toBe(false);
	}, 20_000);

	test("an abort right after calling exec, during setup, still cancels: the command never runs", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		const controller = new AbortController();
		const pending = backend.exec(`sleep 0.3; touch ${path.join(root, "ran")}`, { cwd: root, signal: controller.signal });
		controller.abort();
		const result = await pending;
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBeNull();
		await Bun.sleep(600);
		expect(await Bun.file(path.join(root, "ran")).exists()).toBe(false);
	});

	test("a timeout that ends the CLI before it writes a status is reported as the timeout, not a failure", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		for (const timeoutMs of [0, 1]) {
			const result = await backend.exec("sleep 30", { cwd: root, timeoutMs });
			expect(result.timedOut).toBe(true);
			expect(result.exitCode).toBeNull();
		}
	});

	test("a command's own exit 143 is an exit code, not a signal", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		const result = await backend.exec("exit 143", { cwd: root });
		expect(result.exitCode).toBe(143);
		expect(result.signal).toBeNull();
	});

	test("a cwd whose name begins or ends with a space is kept, in exec and in the shell line", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		for (const name of [" leading", "trailing ", " both "]) {
			await fs.mkdir(path.join(root, name));
			const result = await backend.exec("pwd", { cwd: path.join(root, name) });
			expect(result.stdout).toBe(`${path.join(root, name)}\n`);
			const line = await runLine(backend.shellCommand("pwd", { cwd: path.join(root, name) }));
			expect(line.stdout).toBe(`${path.join(root, name)}\n`);
		}
	});

	test("exec stops capturing at maxOutputBytes, and a gitmoot failure rejects with its code", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		const big = await backend.exec("head -c 5000 /dev/zero | tr '\\0' x", { cwd: root, maxOutputBytes: 100 });
		expect(big.stdout.length).toBe(100);
		expect(big.truncated).toBe(true);
		await fs.rm(path.join(root, "sub dir"), { recursive: true });
		const error = await backend.exec("true", { cwd: path.join(root, "sub dir") }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitmootCliError);
	});
});

describe("GitmootBackend files and sync", () => {
	const bytes = (text: string) => new TextEncoder().encode(text);
	const text = (data: Uint8Array) => new TextDecoder().decode(data);
	const code = async (promise: Promise<unknown>) => ((await promise.catch((e: unknown) => e)) as BackendError).code;

	test("readFile, writeFile and stat: contents, kept and given modes, and the documented refusals", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		await backend.writeFile(path.join(root, "new/deep/a.txt"), "one");
		expect(text(await backend.readFile(path.join(root, "new/deep/a.txt")))).toBe("one");
		expect((await fs.stat(path.join(root, "new/deep/a.txt"))).mode & 0o777).toBe(0o644);
		await fs.chmod(path.join(root, "new/deep/a.txt"), 0o700);
		await backend.writeFile(path.join(root, "new/deep/a.txt"), bytes("two"));
		expect((await fs.stat(path.join(root, "new/deep/a.txt"))).mode & 0o777).toBe(0o700);
		await backend.writeFile(path.join(root, "new/deep/a.txt"), "three", { mode: 0o755 });
		expect((await fs.stat(path.join(root, "new/deep/a.txt"))).mode & 0o777).toBe(0o755);
		expect(await backend.stat(path.join(root, "new/deep/a.txt"))).toMatchObject({ path: path.join(root, "new/deep/a.txt"), type: "file", size: 5 });
		const statted = await backend.stat(path.join(root, "new/deep/a.txt"));
		expect(Math.abs((statted?.mtimeMs ?? 0) - (await fs.stat(path.join(root, "new/deep/a.txt"))).mtimeMs)).toBeLessThan(2);
		expect(await backend.stat(path.join(root, "missing"))).toBeNull();
		await fs.symlink("/etc/passwd", path.join(root, "link"));
		expect((await backend.stat(path.join(root, "link")))?.type).toBe("symlink");
		expect(await code(backend.readFile(path.join(root, "missing")))).toBe("ENOENT");
		expect(await code(backend.readFile(path.join(root, "new")))).toBe("EISDIR");
		expect(await code(backend.writeFile(path.join(root, "new"), "x"))).toBe("EISDIR");
		expect(await code(backend.readFile(path.join(root, "link")))).toBe("SYMLINK");
		expect(await code(backend.writeFile(path.join(root, "link"), "x"))).toBe("SYMLINK");
		expect(await fs.readFile("/etc/passwd", "utf8")).not.toBe("x");
		expect(await code(backend.readFile("/etc/passwd"))).toBe("OUTSIDE_ROOT");
		expect(await code(backend.readFile(path.join(root, "../x")))).toBe("OUTSIDE_ROOT");
	}, 60_000);

	test("list: sorted by path in byte order, recursive or not, limited, never entering a symlinked directory", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		await fs.writeFile(path.join(root, "B"), "bb");
		await fs.writeFile(path.join(root, "sub dir/a b.txt"), "x");
		await fs.symlink("/etc", path.join(root, "etc-link"));
		const rel = (entries: { path: string; type: string }[]) => entries.map(e => `${path.relative(root, e.path)}:${e.type}`);
		expect(rel((await backend.list(root)).entries)).toEqual(["B:file", "etc-link:symlink", "sub dir:dir"]);
		expect(rel((await backend.list(root, { recursive: true })).entries)).toEqual(["B:file", "etc-link:symlink", "sub dir:dir", "sub dir/a b.txt:file"]);
		expect((await backend.list(root, { recursive: true })).entries[0]?.size).toBe(2);
		const cut = await backend.list(root, { recursive: true, limit: 2 });
		expect(cut.truncated).toBe(true);
		expect(rel(cut.entries)).toEqual(["B:file", "etc-link:symlink"]);
		expect(await code(backend.list(path.join(root, "etc-link")))).toBe("SYMLINK");
		expect(await code(backend.list(path.join(root, "B")))).toBe("ENOTDIR");
		expect(await code(backend.list(path.join(root, "gone")))).toBe("ENOENT");
	}, 60_000);

	test("names that look like flags are paths, and list keeps an entry dated before 1970", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		for (const name of ["--json", "--home", "-plain"]) {
			await backend.writeFile(path.join(root, name), name);
			expect(text(await backend.readFile(path.join(root, name)))).toBe(name);
			expect((await backend.stat(path.join(root, name)))?.type).toBe("file");
		}
		await fs.writeFile(path.join(root, "old"), "o");
		await fs.utimes(path.join(root, "old"), new Date(-86_400_000), new Date(-86_400_000));
		const entry = (await backend.list(root)).entries.find(e => e.path === path.join(root, "old"));
		expect(entry?.mtimeMs).toBe(-86_400_000);
	}, 60_000);

	test("changes maps gitmoot's reset to full, seconds to ms, and keeps only permission bits", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		await fs.writeFile(path.join(root, "run.sh"), "#!/bin/sh\n");
		await fs.chmod(path.join(root, "run.sh"), 0o755);
		const changes = await backend.changes("ws1.anything");
		expect(changes.full).toBe(true);
		expect(changes.token.startsWith("ws1.")).toBe(true);
		const entry = changes.changed.find(e => e.path === "run.sh");
		expect(entry).toMatchObject({ type: "file", size: 10, mode: 0o755 });
		expect(Math.abs((entry?.mtimeMs ?? 0) - (await fs.stat(path.join(root, "run.sh"))).mtimeMs)).toBeLessThan(2);
	}, 60_000);

	test("pull returns regular files with their modes and leaves out what is missing, a directory or a symlink", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		await fs.writeFile(path.join(root, "sub dir/x.sh"), "echo\n", { mode: 0o750 });
		await fs.chmod(path.join(root, "sub dir/x.sh"), 0o750);
		await fs.symlink("sub dir/x.sh", path.join(root, "link"));
		const name = `${"long/".repeat(25)}file.txt`;
		await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await fs.writeFile(path.join(root, name), "deep");
		const files = await backend.pull(["sub dir/x.sh", "link", "sub dir", "missing", name]);
		expect(files.map(f => [f.path, f.mode, text(f.data)])).toEqual([
			["sub dir/x.sh", 0o750, "echo\n"],
			[name, 0o644, "deep"],
		]);
		expect(await code(backend.pull(["../etc/passwd"]))).toBe("INVALID_PATH");
	}, 60_000);

	test("push writes files with their modes, creating parents; it refuses a symlink or directory there and applies nothing", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		await backend.push([
			{ path: "a/b/c.txt", mode: 0o600, data: bytes("c") },
			{ path: "top.sh", mode: 0o755, data: bytes("t") },
		]);
		expect(await fs.readFile(path.join(root, "a/b/c.txt"), "utf8")).toBe("c");
		expect((await fs.stat(path.join(root, "a/b/c.txt"))).mode & 0o777).toBe(0o600);
		expect((await fs.stat(path.join(root, "top.sh"))).mode & 0o777).toBe(0o755);
		await fs.symlink("/etc/passwd", path.join(root, "link"));
		const first = { path: "first.txt", mode: 0o644, data: bytes("1") };
		expect(await code(backend.push([first, { path: "link", mode: 0o644, data: bytes("x") }]))).toBe("SYMLINK");
		expect(await code(backend.push([first, { path: "sub dir", mode: 0o644, data: bytes("x") }]))).toBe("EISDIR");
		expect(await Bun.file(path.join(root, "first.txt")).exists()).toBe(false);
	}, 60_000);

	test("remove unlinks files and symlinks without following them, keeps a non-empty directory, and still removes the rest", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		const outside = path.join(root, "..", `${path.basename(root)}-outside`);
		await fs.writeFile(outside, "keep");
		try {
			await fs.symlink(outside, path.join(root, "link"));
			await fs.writeFile(path.join(root, "sub dir/kept.txt"), "k");
			await fs.mkdir(path.join(root, "empty"));
			await fs.writeFile(path.join(root, "z.txt"), "z");
			// Deepest first, as the Mirror sends them: the non-empty directory comes before later paths.
			await backend.remove(["link", "sub dir", "missing/deeper", "empty", "z.txt"]);
			expect(await fs.readFile(outside, "utf8")).toBe("keep");
			expect((await fs.readdir(root)).sort()).toEqual(["sub dir"]);
			expect(await fs.readdir(path.join(root, "sub dir"))).toEqual(["kept.txt"]);
		} finally {
			await fs.rm(outside, { force: true });
		}
	}, 60_000);

	test("a Mirror over GitmootBackend: the sandbox fills the host copy, and host edits, modes and deletes go back", async () => {
		const backend = await GitmootBackend.open({ bin: FAKE, workspace: "ws-test" });
		const host = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-gitmoot-host-"));
		try {
			await fs.writeFile(path.join(root, "sub dir/a.txt"), "a");
			await fs.writeFile(path.join(root, "keep.txt"), "k");
			const mirror = await Mirror.create(backend, host);
			await mirror.pullRemote();
			expect(await fs.readFile(path.join(host, "sub dir/a.txt"), "utf8")).toBe("a");
			await fs.writeFile(path.join(host, "keep.txt"), "k2");
			await fs.chmod(path.join(host, "keep.txt"), 0o700);
			await fs.mkdir(path.join(host, "new"));
			await fs.writeFile(path.join(host, "new/n.txt"), "n");
			await fs.rm(path.join(host, "sub dir"), { recursive: true });
			await mirror.pushLocal();
			expect((await fs.readdir(root)).sort()).toEqual(["keep.txt", "new"]);
			expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("k2");
			expect((await fs.stat(path.join(root, "keep.txt"))).mode & 0o777).toBe(0o700);
			await fs.writeFile(path.join(root, "new/n.txt"), "from the sandbox");
			await mirror.pullRemote();
			expect(await fs.readFile(path.join(host, "new/n.txt"), "utf8")).toBe("from the sandbox");
		} finally {
			await fs.rm(host, { recursive: true, force: true });
		}
	}, 60_000);
});
