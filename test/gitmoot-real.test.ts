// GitmootBackend against the real gitmoot binary with its zero-cost
// `provider = "local"` workspace provider (dev/test only, no isolation), set
// up the way gitmoot's own TestWorkspaceLocalProviderDrivesBuiltBinary does:
// a throwaway home, a local origin repository, `workspace open`. Skipped
// unless GITMOOT_WS_BIN names a gitmoot build that has `workspace`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitmootBackend } from "../src/gitmoot-backend.ts";

const BIN = process.env.GITMOOT_WS_BIN ?? "";
const available = BIN !== "" && (await Bun.file(BIN).exists());

let scratch: string;
let home: string;
let workspace: string;

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
	return { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, GITMOOT_ORG_ROLE: "intern", HOST_SECRET: "must-not-leak", ...extra };
}

async function run(argv: string[], cwd: string = scratch, env: Record<string, string> = cliEnv()): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
}

async function ok(argv: string[], cwd?: string): Promise<string> {
	const result = await run(argv, cwd);
	if (result.code !== 0) throw new Error(`${argv.join(" ")} exited ${result.code}: ${result.stderr}`);
	return result.stdout;
}

beforeAll(async () => {
	if (!available) return;
	scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-gitmoot-real-")));
	home = path.join(scratch, "home");
	await fs.mkdir(home);
	await ok([BIN, "init", "--home", home]);
	const config = (await ok(["/bin/bash", "-c", `ls "${home}"/.gitmoot/config.toml`])).trim();
	await fs.appendFile(config, '\n[workspaces]\nenabled = true\nprovider = "local"\n');
	const origin = path.join(scratch, "origin.git");
	const seed = path.join(scratch, "seed");
	const checkout = path.join(scratch, "checkout");
	const git = (args: string[], cwd = scratch) => ok(["/usr/bin/git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], cwd);
	await git(["init", "--quiet", "--bare", "--initial-branch=main", origin]);
	await git(["init", "--quiet", "--initial-branch=main", seed]);
	await fs.writeFile(path.join(seed, "README.md"), "widget\n");
	await git(["add", "README.md"], seed);
	await git(["commit", "--quiet", "-m", "initial"], seed);
	await git(["push", "--quiet", origin, "main"], seed);
	await git(["clone", "--quiet", origin, checkout]);
	// `repo add` accepts only GitHub remotes. Name origin as GitHub and send
	// git to the local bare repository instead, in this checkout's own config:
	// nothing touches the network.
	await git(["remote", "set-url", "origin", "https://github.com/acme/widget.git"], checkout);
	await git(["config", `url.${origin}.insteadOf`, "https://github.com/acme/widget.git"], checkout);
	await ok([BIN, "repo", "add", "--home", home, "acme/widget", "--path", checkout]);
	const opened = JSON.parse(await ok([BIN, "workspace", "open", "--home", home, "--repo", "acme/widget", "--issue", "5", "--json"])) as { id: string; provider: string; state: string };
	if (opened.provider !== "local" || opened.state !== "ready") throw new Error(`open returned ${JSON.stringify(opened)}`);
	workspace = opened.id;
}, 120_000);

afterAll(async () => {
	if (!available) return;
	if (workspace !== undefined) await run([BIN, "workspace", "close", workspace, "--home", home]);
	await fs.rm(scratch, { recursive: true, force: true });
});

describe.if(available)("GitmootBackend with the real gitmoot binary (provider=local)", () => {
	test("open finds the workspace, and the shell line runs there without the host environment, keeping the exit status", async () => {
		const backend = await GitmootBackend.open({ bin: BIN, workspace, home });
		expect(backend.root.startsWith(path.join(home, ".gitmoot", "execbackends", "local"))).toBe(true);
		const line = backend.shellCommand('cat README.md; pwd; echo "secret=[${HOST_SECRET-}] extra=[$EXTRA]" >&2; exit 3', { cwd: backend.root, env: { EXTRA: "it's here" } });
		const result = await run(["/bin/bash", "-c", line], os.tmpdir(), cliEnv());
		expect(result.code).toBe(3);
		expect(result.stdout).toBe(`widget\n${backend.root}\n`);
		expect(result.stderr).toBe("secret=[] extra=[it's here]\n");
	}, 60_000);

	test("a cwd outside the root never reaches the CLI; one the CLI refuses exits 125", async () => {
		const backend = await GitmootBackend.open({ bin: BIN, workspace, home });
		expect(() => backend.shellCommand("true", { cwd: "/etc" })).toThrow();
		const line = backend.shellCommand("true", { cwd: backend.root }).replace("--cwd '.'", "--cwd 'no-such-dir'");
		const result = await run(["/bin/bash", "-c", line], os.tmpdir(), cliEnv());
		expect(result.code).toBe(125);
		expect(result.stderr).toContain('"error"');
	}, 60_000);

	test("killing the shell line, as omp's bash timeout does, ends the command in the workspace", async () => {
		const backend = await GitmootBackend.open({ bin: BIN, workspace, home });
		const token = `omp-sandbox-kill-${process.pid}-${Date.now()}`;
		const marker = path.join(backend.root, `${token}.done`);
		// The command outlives the watchdog's 15 s silence window, so only a kill stops the marker.
		const child = Bun.spawn(["/bin/bash", "-c", backend.shellCommand(`sleep 25; touch ${token}.done`, { cwd: backend.root })], {
			cwd: os.tmpdir(),
			env: cliEnv(),
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		await Bun.sleep(1500);
		// omp kills the whole process group of the command it started.
		process.kill(-child.pid, "SIGKILL");
		await child.exited;
		await Bun.sleep(30_000);
		expect(await Bun.file(marker).exists()).toBe(false);
	}, 60_000);

	test("exec reports output, exit code and a timeout through the real CLI's status file", async () => {
		const backend = await GitmootBackend.open({ bin: BIN, workspace, home });
		const result = await backend.exec('cat README.md; echo "e=[$EXTRA]" >&2; exit 6', { cwd: backend.root, env: { EXTRA: "x y" } });
		expect(result).toMatchObject({ exitCode: 6, signal: null, stdout: "widget\n", stderr: "e=[x y]\n" });
		const slow = await backend.exec("sleep 30", { cwd: backend.root, timeoutMs: 1000 });
		expect(slow.timedOut).toBe(true);
		expect(slow.exitCode).toBeNull();
		expect(slow.signal).not.toBeNull();
	}, 60_000);

	test("the real CLI keeps a cwd name with leading or trailing spaces, and a startup timeout is a timeout", async () => {
		const backend = await GitmootBackend.open({ bin: BIN, workspace, home });
		for (const name of [" leading", "trailing "]) {
			await fs.mkdir(path.join(backend.root, name));
			const result = await backend.exec("pwd", { cwd: path.join(backend.root, name) });
			expect(result.stdout).toBe(`${path.join(backend.root, name)}\n`);
		}
		for (const timeoutMs of [0, 1]) {
			const result = await backend.exec("sleep 30", { cwd: backend.root, timeoutMs });
			expect(result.timedOut).toBe(true);
		}
		const exited = await backend.exec("exit 143", { cwd: backend.root });
		expect(exited.exitCode).toBe(143);
		expect(exited.signal).toBeNull();
	}, 60_000);

	test("containment is the process group: a setsid descendant outlives a timeout, as process-group says", async () => {
		const backend = await GitmootBackend.open({ bin: BIN, workspace, home });
		expect(backend.containment).toBe("process-group");
		const result = await backend.exec("setsid sleep 30 </dev/null >/dev/null 2>&1 & echo $!; sleep 30", { cwd: backend.root, timeoutMs: 1000 });
		expect(result.timedOut).toBe(true);
		const pid = Number.parseInt(result.stdout.trim(), 10);
		// provider=local runs on this host, so the descendant is visible here; stop it.
		expect(() => process.kill(pid, 0)).not.toThrow();
		process.kill(pid, "SIGKILL");
	}, 60_000);
});
