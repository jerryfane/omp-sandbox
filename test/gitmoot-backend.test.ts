// GitmootBackend against a fake gitmoot CLI that follows the pinned contract
// (test/fixtures/fake-gitmoot.sh). Proves the command line the backend builds
// for omp's bash; the real CLI replaces the fake once it exists.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BackendError } from "../src/backend.ts";
import { GitmootBackend, GitmootCliError } from "../src/gitmoot-backend.ts";

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
