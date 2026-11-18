import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

/**
 * True once `pid` no longer runs (gone, or a zombie waiting to be reaped).
 * SIGKILL takes effect asynchronously in the kernel, so this polls the real
 * process table with a deadline: it waits for the condition, not a guess.
 */
async function processGone(pid: number, deadlineMs = 3_000): Promise<boolean> {
	const until = Date.now() + deadlineMs;
	for (;;) {
		const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
		// Field 3, after the ")" that closes the command name, is the state.
		const close = stat.lastIndexOf(")");
		const state = stat.slice(close + 2, close + 3);
		if (stat === "" || state === "Z" || state === "X") return true;
		if (Date.now() > until) return false;
		await Bun.sleep(20);
	}
}

describe("exec", () => {
	test("runs in the given cwd and reports stdout, stderr and the exit code separately", async () => {
		await fs.mkdir(path.join(sandboxDir, "sub"));
		const result = await backend.exec("pwd; echo oops >&2; exit 3", { cwd: path.join(backend.root, "sub") });
		expect(result.stdout).toBe(`${path.join(backend.root, "sub")}\n`);
		expect(result.stderr).toBe("oops\n");
		expect(result.exitCode).toBe(3);
		expect(result.timedOut || result.aborted || result.truncated).toBe(false);
	});

	test("starts from a minimal environment, never the host's", async () => {
		process.env.OMP_SANDBOX_HOST_SECRET = "must-not-leak";
		try {
			const result = await backend.exec('echo "[$OMP_SANDBOX_HOST_SECRET][$EXTRA][$HOME]"', {
				cwd: backend.root,
				env: { EXTRA: "given" },
			});
			expect(result.stdout).toBe(`[][given][${backend.root}]\n`);
		} finally {
			delete process.env.OMP_SANDBOX_HOST_SECRET;
		}
	});

	test("streams output in arrival order", async () => {
		const chunks: string[] = [];
		// The sleeps run inside the command, so each line arrives as its own chunk.
		await backend.exec("echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three", {
			cwd: backend.root,
			onOutput: (chunk, stream) => chunks.push(`${stream}:${chunk}`),
		});
		expect(chunks).toEqual(["stdout:one\n", "stderr:two\n", "stdout:three\n"]);
	});

	test("a timeout kills the command and everything it started", async () => {
		const pids: number[] = [];
		const started = Date.now();
		// timeoutMs is the real-time behaviour under test, so a real clock is needed here.
		const result = await backend.exec("sleep 30 & echo $!; sleep 30", {
			cwd: backend.root,
			timeoutMs: 200,
			onOutput: chunk => pids.push(Number.parseInt(chunk, 10)),
		});
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(pids.length).toBe(1);
		expect(await processGone(pids[0] ?? -1)).toBe(true);
	});

	test("aborting kills the command; an already-aborted signal never starts it", async () => {
		const controller = new AbortController();
		const result = await backend.exec("echo started; sleep 30", {
			cwd: backend.root,
			signal: controller.signal,
			onOutput: () => controller.abort(),
		});
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(result.stdout).toBe("started\n");

		const marker = path.join(sandboxDir, "ran");
		const late = await backend.exec(`touch ${marker}`, { cwd: backend.root, signal: controller.signal });
		expect(late.aborted).toBe(true);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test("stops capturing at maxOutputBytes without cutting a UTF-8 character", async () => {
		const result = await backend.exec("printf 'ééééé'; printf 'zz' >&2", { cwd: backend.root, maxOutputBytes: 5 });
		expect(result.truncated).toBe(true);
		expect(result.stdout).toBe("éé");
		expect(result.stderr).toBe("zz");
	});

	test("returns once the shell exits even if a background process keeps the pipes open", async () => {
		const started = Date.now();
		const result = await backend.exec("sleep 30 & echo $!", { cwd: backend.root });
		const pid = Number.parseInt(result.stdout, 10);
		try {
			expect(result.exitCode).toBe(0);
			expect(Date.now() - started).toBeLessThan(3_000);
		} finally {
			process.kill(pid, "SIGKILL");
		}
	});

	test("refuses a cwd outside the root", async () => {
		await rejectsWith(backend.exec("true", { cwd: hostDir }), "OUTSIDE_ROOT");
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

	test("missing files and directories give typed errors", async () => {
		await rejectsWith(backend.readFile(path.join(backend.root, "nope")), "ENOENT");
		await fs.mkdir(path.join(sandboxDir, "dir"));
		await rejectsWith(backend.readFile(path.join(backend.root, "dir")), "EISDIR");
		expect(await backend.stat(path.join(backend.root, "nope"))).toBeNull();
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

	test("list is sorted, recursive on request, and honours the limit", async () => {
		await fs.mkdir(path.join(sandboxDir, "b/inner"), { recursive: true });
		await fs.writeFile(path.join(sandboxDir, "a.txt"), "");
		await fs.writeFile(path.join(sandboxDir, "b/inner/z.txt"), "");
		const top = await backend.list(backend.root);
		expect(top.entries.map(e => path.basename(e.path))).toEqual(["a.txt", "b"]);
		const all = await backend.list(backend.root, { recursive: true });
		expect(all.entries.map(e => path.relative(backend.root, e.path))).toEqual(["a.txt", "b", "b/inner", "b/inner/z.txt"]);
		expect(all.truncated).toBe(false);
		const cut = await backend.list(backend.root, { recursive: true, limit: 2 });
		expect(cut.entries.length).toBe(2);
		expect(cut.truncated).toBe(true);
	});
});

describe("confinement: file operations never reach the host", () => {
	test("absolute host paths and .. escapes are refused", async () => {
		await fs.writeFile(path.join(hostDir, "secret"), "host data");
		await rejectsWith(backend.readFile(path.join(hostDir, "secret")), "OUTSIDE_ROOT");
		await rejectsWith(backend.readFile(path.join(backend.root, "../host/secret")), "OUTSIDE_ROOT");
		await rejectsWith(backend.writeFile(path.join(hostDir, "planted"), "x"), "OUTSIDE_ROOT");
		await rejectsWith(backend.list(hostDir), "OUTSIDE_ROOT");
		await rejectsWith(backend.readFile("relative/path"), "INVALID_PATH");
		expect(await Bun.file(path.join(hostDir, "planted")).exists()).toBe(false);
	});

	test("a symlink pointing at the host is refused for read and write", async () => {
		await fs.writeFile(path.join(hostDir, "secret"), "host data");
		await fs.symlink(path.join(hostDir, "secret"), path.join(sandboxDir, "to-secret"));
		await fs.symlink(hostDir, path.join(sandboxDir, "to-host"));
		await rejectsWith(backend.readFile(path.join(backend.root, "to-secret")), "OUTSIDE_ROOT");
		await rejectsWith(backend.writeFile(path.join(backend.root, "to-host/planted"), "x"), "OUTSIDE_ROOT");
		await rejectsWith(backend.writeFile(path.join(backend.root, "to-host/new/deep"), "x"), "OUTSIDE_ROOT");
		expect(await fs.readdir(hostDir)).toEqual(["secret"]);
		expect(await fs.readFile(path.join(hostDir, "secret"), "utf8")).toBe("host data");
	});

	test("a recursive list does not follow a symlinked directory out of the root", async () => {
		await fs.writeFile(path.join(hostDir, "secret"), "host data");
		await fs.symlink(hostDir, path.join(sandboxDir, "to-host"));
		const all = await backend.list(backend.root, { recursive: true });
		expect(all.entries.map(e => path.relative(backend.root, e.path))).toEqual(["to-host"]);
		expect(all.entries[0]?.type).toBe("symlink");
	});
});
