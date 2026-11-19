// GitmootBackend against the real gitmoot binary with its zero-cost
// `provider = "local"` workspace provider (dev/test only, no isolation), set
// up the way gitmoot's own TestWorkspaceLocalProviderDrivesBuiltBinary does:
// a throwaway home, a local origin repository, `workspace open`. Skipped
// unless GITMOOT_WS_BIN names a gitmoot build that has `workspace`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitmootBackend, GitmootCliError } from "../src/gitmoot-backend.ts";
import { Mirror } from "../src/mirror.ts";

const BIN = process.env.GITMOOT_WS_BIN ?? "";
const available = BIN !== "" && (await Bun.file(BIN).exists());
const OMP = process.env.OMP_BIN ?? "/root/.local/bin/omp";
const ompInstalled = await Bun.file(OMP).exists();

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

	test("files: write, read, stat and list through the real CLI, with its refusals", async () => {
		const backend = await GitmootBackend.open({ bin: BIN, workspace, home });
		const dir = path.join(backend.root, "files-test");
		await backend.writeFile(path.join(dir, "deep/a.sh"), "#!/bin/sh\n", { mode: 0o750 });
		expect(new TextDecoder().decode(await backend.readFile(path.join(dir, "deep/a.sh")))).toBe("#!/bin/sh\n");
		expect((await fs.stat(path.join(dir, "deep/a.sh"))).mode & 0o777).toBe(0o750);
		expect(await backend.stat(path.join(dir, "deep/a.sh"))).toMatchObject({ type: "file", size: 10 });
		expect(await backend.stat(path.join(dir, "nope"))).toBeNull();
		await fs.symlink("/etc/passwd", path.join(dir, "link"));
		expect((await backend.stat(path.join(dir, "link")))?.type).toBe("symlink");
		const code = async (promise: Promise<unknown>) => ((await promise.catch((e: unknown) => e)) as { code?: string }).code;
		expect(await code(backend.readFile(path.join(dir, "nope")))).toBe("ENOENT");
		expect(await code(backend.readFile(path.join(dir, "deep")))).toBe("EISDIR");
		expect(await code(backend.readFile(path.join(dir, "link")))).toBe("SYMLINK");
		expect(await code(backend.writeFile(path.join(dir, "link"), "x"))).toBe("SYMLINK");
		const listed = await backend.list(dir, { recursive: true });
		expect(listed.entries.map(e => `${path.relative(dir, e.path)}:${e.type}`)).toEqual(["deep:dir", "deep/a.sh:file", "link:symlink"]);
	}, 60_000);

	test("sync: changes is incremental with exact deletes; pull, push and remove keep their contracts", async () => {
		const backend = await GitmootBackend.open({ bin: BIN, workspace, home });
		const base = await backend.changes();
		expect(base.full).toBe(true);
		await fs.mkdir(path.join(backend.root, "sync-test/full"), { recursive: true });
		await fs.writeFile(path.join(backend.root, "sync-test/full/kept.txt"), "k");
		await backend.push([
			{ path: "sync-test/a.txt", mode: 0o600, data: new TextEncoder().encode("a") },
			{ path: "sync-test/new/b.txt", mode: 0o644, data: new TextEncoder().encode("b") },
		]);
		const pulled = await backend.pull(["sync-test/a.txt", "sync-test/new", "sync-test/missing"]);
		expect(pulled.map(f => [f.path, f.mode, new TextDecoder().decode(f.data)])).toEqual([["sync-test/a.txt", 0o600, "a"]]);
		const after = await backend.changes(base.token);
		expect(after.full).toBe(false);
		expect(after.changed.map(e => e.path)).toEqual(expect.arrayContaining(["sync-test/a.txt", "sync-test/new/b.txt", "sync-test/full/kept.txt"]));
		// The Mirror's order: deepest first. The non-empty directory stays, the rest goes.
		await backend.remove(["sync-test/new/b.txt", "sync-test/new", "sync-test/full", "sync-test/a.txt", "sync-test/gone"]);
		expect((await fs.readdir(path.join(backend.root, "sync-test"))).sort()).toEqual(["full"]);
		const deleted = await backend.changes(after.token);
		expect(deleted.deleted.sort()).toEqual(["sync-test/a.txt", "sync-test/new", "sync-test/new/b.txt"]);
		const refused = await backend.remove([".git/HEAD"]).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(GitmootCliError);
	}, 60_000);

	test("a Mirror over the real CLI: fills the host copy, sends host edits and deletes, brings sandbox edits back", async () => {
		const backend = await GitmootBackend.open({ bin: BIN, workspace, home });
		const host = await fs.mkdtemp(path.join(scratch, "mirror-"));
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		expect(await fs.readFile(path.join(host, "README.md"), "utf8")).toBe("widget\n");
		await fs.writeFile(path.join(host, "README.md"), "widget, edited on the host\n");
		await fs.mkdir(path.join(host, "mirror-new"));
		await fs.writeFile(path.join(host, "mirror-new/n.txt"), "n");
		await mirror.pushLocal();
		expect(await fs.readFile(path.join(backend.root, "README.md"), "utf8")).toBe("widget, edited on the host\n");
		expect(await fs.readFile(path.join(backend.root, "mirror-new/n.txt"), "utf8")).toBe("n");
		await fs.rm(path.join(host, "mirror-new"), { recursive: true });
		await mirror.pushLocal();
		expect(await Bun.file(path.join(backend.root, "mirror-new")).exists()).toBe(false);
		await fs.writeFile(path.join(backend.root, "README.md"), "widget, edited in the sandbox\n");
		await mirror.pullRemote();
		expect(await fs.readFile(path.join(host, "README.md"), "utf8")).toBe("widget, edited in the sandbox\n");
	}, 120_000);

	test.if(ompInstalled)("installed omp with OMP_SANDBOX_BACKEND=gitmoot: bash and the file tools act on the workspace, never the host", async () => {
		const backend = await GitmootBackend.open({ bin: BIN, workspace, home });
		const agentDir = path.join(scratch, "omp-agent");
		const hostDir = path.join(scratch, "omp-host");
		await fs.mkdir(agentDir, { recursive: true });
		// Replace-mode edit (old_string/new_string) for the scripted model, as in omp-integration.test.ts.
		await fs.writeFile(path.join(agentDir, "config.yml"), "edit:\n  modelVariants:\n    scripted: replace\n");
		await fs.mkdir(hostDir);
		const script = [
			{ name: "bash", arguments: { command: 'pwd; echo "secret=[${OMP_SANDBOX_TEST_HOST_SECRET-}]"; echo from-bash > omp-bash.txt' } },
			{ name: "read", arguments: { path: "README.md" } },
			{ name: "write", arguments: { path: "omp-dir/written.txt", content: "written by omp\n" } },
			{ name: "edit", arguments: { path: "omp-bash.txt", old_string: "from-bash", new_string: "edited" } },
			{ name: "bash", arguments: { command: "cat omp-dir/written.txt omp-bash.txt" } },
		];
		const child = Bun.spawn(
			[OMP, "--trusted-extension", path.join(import.meta.dir, "fixtures/scripted-provider.ts"), "--trusted-extension", path.resolve(import.meta.dir, "../src/extension.ts"), "--model", "scripted/scripted-1", "--no-session", "--mode", "json", "-p", "go"],
			{
				cwd: hostDir,
				env: {
					HOME: path.join(scratch, "omp-home"),
					PATH: "/usr/local/bin:/usr/bin:/bin",
					TERM: "dumb",
					GITMOOT_ORG_ROLE: "intern",
					PI_CODING_AGENT_DIR: agentDir,
					PI_CONFIG_DIR: path.join(scratch, "omp-config"),
					OMP_SANDBOX_SCRIPT: JSON.stringify(script),
					OMP_SANDBOX_BACKEND: "gitmoot",
					OMP_SANDBOX_GITMOOT_BIN: BIN,
					OMP_SANDBOX_GITMOOT_HOME: home,
					OMP_SANDBOX_GITMOOT_WORKSPACE: workspace,
					OMP_SANDBOX_TEST_HOST_SECRET: "must-not-leak",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(exitCode).toBe(0);
		const ends = stdout
			.split("\n")
			.filter(line => line.includes('"tool_execution_end"'))
			.map(line => JSON.parse(line) as { isError?: boolean; result?: { isError?: boolean; content?: { text?: string }[] } })
			.map(end => ({ isError: end.isError === true || end.result?.isError === true, text: (end.result?.content ?? []).map(c => c.text ?? "").join("") }));
		expect(ends.map(end => (end.isError ? end.text : false))).toEqual([false, false, false, false, false]);
		expect(ends[0]?.text).toContain(`${backend.root}\nsecret=[]`);
		expect(ends[1]?.text).toContain("widget");
		expect(ends[4]?.text).toContain("written by omp\nedited");
		expect(await fs.readFile(path.join(backend.root, "omp-dir/written.txt"), "utf8")).toBe("written by omp\n");
		expect(await fs.readFile(path.join(backend.root, "omp-bash.txt"), "utf8")).toBe("edited\n");
		// The host directory is the mirror: it follows the workspace.
		expect(await fs.readFile(path.join(hostDir, "omp-bash.txt"), "utf8")).toBe("edited\n");
	}, 180_000);
});
