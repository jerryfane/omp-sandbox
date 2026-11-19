// Runs the installed omp headless with the real extension and a scripted
// provider (no model, no spend), against LocalBackend. Skipped when omp is
// not installed. Everything omp writes goes to a throwaway agent dir and HOME.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const OMP = process.env.OMP_BIN || Bun.which("omp") || "";
const ompInstalled = OMP !== "" && (await Bun.file(OMP).exists());

interface ToolEnd {
	toolCallId: string;
	isError: boolean;
	text: string;
	details: Record<string, unknown>;
}

interface Run {
	ends: ToolEnd[];
	asyncResults: string[];
	finalText: string;
	exitCode: number;
	stderr: string;
	/** The host copy of the workspace this run used (omp's cwd). */
	hostDir: string;
	/** The sandbox this run used (LocalBackend's root). */
	sandboxDir: string;
}

let scratch: string;

beforeAll(async () => {
	scratch = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-omp-"));
	for (const dir of [path.join(scratch, "agent"), path.join(scratch, "home")]) {
		await fs.mkdir(dir, { recursive: true });
	}
	// async.enabled is on by default; print mode needs printWake to deliver job results.
	await fs.writeFile(path.join(scratch, "agent/config.yml"), "async:\n  printWake: true\n");
});

afterAll(async () => {
	await fs.rm(scratch, { recursive: true, force: true });
});

/** A new, empty host copy: the extension refuses to start on a non-empty one. */
async function freshHostDir(): Promise<string> {
	return fs.mkdtemp(path.join(scratch, "host-"));
}

/** A new sandbox holding `sub/` and whatever `seed` lists (relative path → contents). */
async function freshSandbox(seed: Record<string, string> = {}): Promise<string> {
	const dir = await fs.mkdtemp(path.join(scratch, "sandbox-"));
	await fs.mkdir(path.join(dir, "sub"));
	for (const [rel, content] of Object.entries(seed)) {
		await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
		await fs.writeFile(path.join(dir, rel), content);
	}
	return dir;
}

/** Runs omp once with the given script of tool calls, in a fresh host copy (or `hostDir`, empty) and sandbox; returns what the session did. */
async function runOmp(
	script: (ScriptedCall | ScriptedCall[])[],
	extraEnv: Record<string, string> = {},
	seed: Record<string, string> = {},
	emptyHostDir?: string,
): Promise<Run> {
	const dir = import.meta.dir;
	const hostDir = emptyHostDir ?? (await freshHostDir());
	const sandboxDir = await freshSandbox(seed);
	const child = Bun.spawn(
		[
			OMP,
			"--trusted-extension",
			path.join(dir, "fixtures/scripted-provider.ts"),
			"--trusted-extension",
			path.resolve(dir, "../src/extension.ts"),
			"--model",
			"scripted/scripted-1",
			"--no-session",
			"--mode",
			"json",
			"-p",
			"go",
		],
		{
			cwd: hostDir,
			env: {
				HOME: path.join(scratch, "home"),
				PATH: "/usr/local/bin:/usr/bin:/bin",
				TERM: "dumb",
				PI_CODING_AGENT_DIR: path.join(scratch, "agent"),
				PI_CONFIG_DIR: path.join(scratch, "config"),
				OMP_SANDBOX_SCRIPT: JSON.stringify(script),
				OMP_SANDBOX_BACKEND: "local",
				OMP_SANDBOX_LOCAL_ROOT: sandboxDir,
				OMP_SANDBOX_TEST_HOST_SECRET: "must-not-leak",
				...extraEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	const run: Run = { ends: [], asyncResults: [], finalText: "", exitCode, stderr, hostDir, sandboxDir };
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "tool_execution_end") {
			const result = (event.result ?? {}) as { content?: { type: string; text?: string }[]; details?: Record<string, unknown>; isError?: boolean };
			run.ends.push({
				toolCallId: String(event.toolCallId),
				isError: event.isError === true || result.isError === true,
				text: (result.content ?? []).map(c => c.text ?? "").join(""),
				details: result.details ?? {},
			});
		}
		if (event.type === "message_end") {
			const message = event.message as { role?: string; customType?: string; content?: unknown };
			if (message.customType === "async-result") run.asyncResults.push(String(message.content));
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const part of message.content as { type: string; text?: string }[]) {
					if (part.type === "text" && part.text !== undefined) run.finalText = part.text;
				}
			}
		}
	}
	return run;
}

interface ScriptedCall {
	name: string;
	arguments: Record<string, unknown>;
}

function bash(args: Record<string, unknown>): ScriptedCall {
	return { name: "bash", arguments: args };
}

/** Live processes whose command line contains `token`; killed so a failure leaves nothing. */
function reapToken(token: string): number {
	let found = 0;
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(token)) {
				found++;
				process.kill(Number(entry), "SIGKILL");
			}
		} catch {
			// exited meanwhile
		}
	}
	return found;
}

describe.if(ompInstalled)("installed omp with the extension (LocalBackend)", () => {
	test("bash runs in the sandbox, never sees the host environment, and keeps omp's own result handling", async () => {
		const token = `53.${randomInt(1e9)}`;
		const run = await runOmp([
			bash({ command: 'pwd; echo "secret=[$OMP_SANDBOX_TEST_HOST_SECRET]"' }),
			bash({ command: "pwd", cwd: "sub" }),
			bash({ command: "touch made-in-sandbox" }),
			bash({ command: "echo failing >&2; exit 7" }),
			bash({ command: "sleep 1 && echo async-done", async: true }),
			bash({ command: `sleep ${token}`, timeout: 2 }),
		]);
		expect(run.finalText).toBe("SCRIPT-DONE");
		const byId = new Map(run.ends.map(end => [end.toolCallId, end]));

		const sandboxDir = run.sandboxDir;
		expect(byId.get("call_0")?.text).toContain(`${sandboxDir}\nsecret=[]`);
		expect(byId.get("call_1")?.text).toContain(path.join(sandboxDir, "sub"));
		expect(await Bun.file(path.join(sandboxDir, "made-in-sandbox")).exists()).toBe(true);
		// The host copy follows the sandbox; nothing bash did happened on the host side first.
		expect((await fs.readdir(run.hostDir)).sort()).toEqual(["made-in-sandbox", "sub"]);

		const failed = byId.get("call_3");
		expect(failed?.isError).toBe(true);
		expect(failed?.details.exitCode).toBe(7);
		expect(failed?.text).toContain("Command exited with code 7");

		// omp's own background-job machinery: a job id now, the result later.
		expect(byId.get("call_4")?.details.async).toMatchObject({ state: "running", type: "bash" });
		expect(run.asyncResults.some(r => r.includes("async-done"))).toBe(true);
		// omp's own timeout, and nothing left running in the sandbox afterwards.
		expect(run.asyncResults.some(r => r.includes("timed out after 2 seconds"))).toBe(true);
		expect(reapToken(token)).toBe(0);
	}, 120_000);

	test("pty, named services and a cwd outside the workspace are refused, not run on the host", async () => {
		const run = await runOmp([
			bash({ command: "echo pty", pty: true }),
			bash({ command: "sleep 1", name: "svc" }),
			bash({ command: "pwd", cwd: "/etc" }),
		]);
		const byId = new Map(run.ends.map(end => [end.toolCallId, end]));
		expect(byId.get("call_0")?.isError).toBe(true);
		expect(byId.get("call_0")?.text).toContain("pty");
		expect(byId.get("call_1")?.isError).toBe(true);
		expect(byId.get("call_1")?.text).toContain("named services");
		expect(byId.get("call_2")?.isError).toBe(true);
		expect(byId.get("call_2")?.text).toContain("outside the sandboxed workspace");
	}, 120_000);

	test("a misconfigured sandbox refuses every bash call instead of running on the host", async () => {
		const run = await runOmp([bash({ command: "touch would-be-on-host" })], {
			OMP_SANDBOX_LOCAL_ROOT: path.join(scratch, "does-not-exist"),
		});
		expect(run.ends[0]?.isError).toBe(true);
		expect(run.ends[0]?.text).toContain("refusing to run on this machine");
		expect(await fs.readdir(run.hostDir)).toEqual([]);
	}, 120_000);

	test("omp's own bash approval rules judge the command the agent wrote", async () => {
		// write mode: exec-tier calls need a prompt, which print mode cannot show,
		// so they fail; bash.patterns decide per command. Matches native bash.
		const agentDir = path.join(scratch, "agent-approval");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			[
				"tools:",
				"  approvalMode: write",
				"bash:",
				"  patterns:",
				'    - { match: "touch denied-*", approval: deny }',
				'    - { match: "touch asked-*", approval: prompt }',
				'    - { match: "touch allowed-*", approval: allow }',
				"",
			].join("\n"),
		);
		const run = await runOmp(
			[
				bash({ command: "touch denied-marker" }),
				bash({ command: "touch asked-marker" }),
				bash({ command: "touch allowed-marker" }),
				bash({ command: "touch plain-marker" }),
			],
			{ PI_CODING_AGENT_DIR: agentDir },
		);
		const byId = new Map(run.ends.map(end => [end.toolCallId, end]));
		expect(byId.get("call_0")?.text).toContain("Blocked by bash pattern: touch denied-*");
		expect(byId.get("call_1")?.text).toContain("requires approval");
		expect(byId.get("call_2")?.isError).toBe(false);
		expect(byId.get("call_3")?.text).toContain("requires approval");
		const sandboxFiles = await fs.readdir(run.sandboxDir);
		expect(sandboxFiles).toContain("allowed-marker");
		for (const blocked of ["denied-marker", "asked-marker", "plain-marker"]) expect(sandboxFiles).not.toContain(blocked);
		expect((await fs.readdir(run.hostDir)).sort()).toEqual(["allowed-marker", "sub"]);
	}, 120_000);

	test("the shadows offer the model the same tools as omp's natives", async () => {
		// bash's schema is mirrored by hand; the file tools' come from omp's own
		// classes. A provider records the tools omp sends the model, once with
		// the natives and once with the extension loaded.
		const recorder = path.join(scratch, "schema-recorder.ts");
		await fs.writeFile(
			recorder,
			`import { appendFileSync } from "node:fs";
const model = { id: "r1", name: "R", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16000 };
export default function (pi) {
	pi.registerProvider("recorder", { baseUrl: "https://recorder.invalid/", apiKey: "unused", api: "recorder-api", models: [model],
		streamSimple(_model, context) {
			const tools = Object.fromEntries((context.tools ?? []).filter(t => ["bash", "read", "write", "edit", "grep", "glob", "find", "ast_grep"].includes(t.name)).map(t => [t.name, { description: t.description, parameters: t.parameters }]));
			appendFileSync(process.env.SCHEMA_OUT, JSON.stringify(tools) + "\\n");
			throw new Error("schema recorded");
		} });
}
`,
		);
		const schemaFor = async (withExtension: boolean): Promise<Record<string, { description: string; parameters: unknown }>> => {
			const out = path.join(scratch, `schema-${withExtension}.jsonl`);
			const extensions = ["--trusted-extension", recorder];
			if (withExtension) extensions.push("--trusted-extension", path.resolve(import.meta.dir, "../src/extension.ts"));
			const child = Bun.spawn([OMP, ...extensions, "--model", "recorder/r1", "--no-session", "-p", "go"], {
				cwd: await freshHostDir(),
				env: {
					HOME: path.join(scratch, "home"),
					PATH: "/usr/local/bin:/usr/bin:/bin",
					TERM: "dumb",
					PI_CODING_AGENT_DIR: path.join(scratch, "agent"),
					PI_CONFIG_DIR: path.join(scratch, "config"),
					SCHEMA_OUT: out,
					OMP_SANDBOX_BACKEND: "local",
					OMP_SANDBOX_LOCAL_ROOT: await freshSandbox(),
				},
				stdout: "ignore",
				stderr: "ignore",
			});
			await child.exited;
			return JSON.parse((await fs.readFile(out, "utf8")).split("\n")[0] ?? "null");
		};
		const native = await schemaFor(false);
		const shadow = await schemaFor(true);
		expect(Object.keys(shadow).sort()).toEqual(Object.keys(native).sort());
		expect(native.bash?.parameters).toMatchObject({ type: "object", properties: { command: { type: "string" } } });
		// bash's description is the add-on's own; names, types, bounds and requiredness must match.
		expect(stripDescriptions(shadow.bash?.parameters)).toEqual(stripDescriptions(native.bash?.parameters));
		// The file tools are omp's own, descriptions included.
		for (const name of Object.keys(native).filter(n => n !== "bash")) expect(shadow[name]).toEqual(native[name]);
	}, 120_000);

	test("omp's own file tools work on the copy, and their changes and bash's meet in the sandbox", async () => {
		const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
		const run = await runOmp(
			[
				call("read", { path: "a.txt" }),
				// {{TAG}}: the snapshot tag from the read just above.
				call("edit", { input: "[a.txt#{{TAG}}]\nPUT 1.=1:\n+line ONE" }),
				call("write", { path: "sub/new.txt", content: "written\n" }),
				bash({ command: "cat a.txt sub/new.txt; rm sub/new.txt; mkdir -p made && echo from-bash > made/b.txt" }),
				call("read", { path: "made/b.txt" }),
				call("grep", { pattern: "from-bash", path: "." }),
				bash({ command: "sleep 1 && echo late > late.txt", async: true }),
				// omp's own wait: no bash call in between, so only the pull before
				// the next file tool can bring late.txt into the copy.
				call("wait", {}),
				call("read", { path: "late.txt" }),
				// The last call of the session: its change must reach the sandbox with no later bash to carry it.
				call("write", { path: "final.txt", content: "last\n" }),
			],
			{},
			{ "a.txt": "line one\nline two\n" },
		);
		expect(run.finalText).toBe("SCRIPT-DONE");
		const byId = new Map(run.ends.map(end => [end.toolCallId, end]));
		for (const id of ["call_0", "call_1", "call_2", "call_3", "call_4", "call_5", "call_8", "call_9"]) expect(byId.get(id)?.isError).toBe(false);
		// The edit and the write reached the sandbox before bash ran there.
		expect(byId.get("call_3")?.text).toContain("line ONE\nline two\nwritten");
		// bash's own changes came back to the copy before the next file tool.
		expect(byId.get("call_4")?.text).toContain("from-bash");
		expect(byId.get("call_5")?.text).toMatch(/# made\/\n## b\.txt#[0-9A-Z]{4}\n\*1:from-bash/);
		expect(byId.get("call_8")?.text).toContain("late");
		expect(await fs.readFile(path.join(run.sandboxDir, "a.txt"), "utf8")).toBe("line ONE\nline two\n");
		expect(await fs.readFile(path.join(run.sandboxDir, "final.txt"), "utf8")).toBe("last\n");
		// Both sides end in the same state; the file bash deleted is gone from the copy too.
		const sandboxTree = (await fs.readdir(run.sandboxDir, { recursive: true })).sort();
		expect((await fs.readdir(run.hostDir, { recursive: true })).sort()).toEqual(sandboxTree);
		expect(sandboxTree).not.toContain("sub/new.txt");
	}, 120_000);

	test("file tools naming a path outside the copy, and tools that run code on this machine, are refused", async () => {
		const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
		const outside = await fs.mkdtemp(path.join(scratch, "outside-"));
		await fs.writeFile(path.join(outside, "secret.txt"), "host-only");
		const run = await runOmp([
			call("read", { path: path.join(outside, "secret.txt") }),
			call("read", { path: "../" }),
			call("grep", { pattern: "host-only", path: outside }),
			call("glob", { path: `${outside}/*` }),
			call("write", { path: path.join(outside, "planted.txt"), content: "x" }),
			call("edit", { input: `[${path.join(outside, "secret.txt")}#ABCD]\nPUT 1.=1:\n+changed` }),
			call("eval", { language: "py", code: "print('ran on host')" }),
			call("read", { path: "sub" }),
			call("ast_edit", { ops: [{ pat: "host-only", out: "changed" }], paths: [outside] }),
			call("write", { path: "lib/.git/hooks/post-checkout", content: "#!/bin/sh\n" }),
			call("read", { path: ".git/config" }),
		]);
		const byId = new Map(run.ends.map(end => [end.toolCallId, end]));
		for (const id of ["call_0", "call_1", "call_2", "call_3", "call_4", "call_5"]) {
			expect(byId.get(id)?.isError).toBe(true);
			expect(byId.get(id)?.text).toContain("outside the sandboxed workspace");
		}
		expect(byId.get("call_6")?.isError).toBe(true);
		expect(byId.get("call_6")?.text).toContain("eval is not available with the sandbox");
		expect(byId.get("call_6")?.text).not.toContain("ran on host");
		// A path inside the copy still works.
		expect(byId.get("call_7")?.isError).toBe(false);
		expect(byId.get("call_8")?.isError).toBe(true);
		expect(byId.get("call_8")?.text).toContain("ast_edit is not available with the sandbox");
		for (const id of ["call_9", "call_10"]) {
			expect(byId.get(id)?.isError).toBe(true);
			expect(byId.get(id)?.text).toContain("is inside a .git directory");
		}
		expect(await Bun.file(path.join(run.hostDir, "lib/.git/hooks/post-checkout")).exists()).toBe(false);
		expect(await Bun.file(path.join(run.sandboxDir, "lib/.git/hooks/post-checkout")).exists()).toBe(false);
		expect(await fs.readdir(outside)).toEqual(["secret.txt"]);
		expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("host-only");
	}, 120_000);

	test("a path that a file tool could read as several paths, or an encoded one, is refused in every file tool; one plain path still works", async () => {
		const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
		const outside = await fs.mkdtemp(path.join(scratch, "outside-"));
		const secret = path.join(outside, "secret.txt");
		await fs.writeFile(secret, "HOST-ONLY-SECRET");
		const hostDir = await freshHostDir();
		// One case per refused class; each pairs a file inside the copy with the host file.
		const classes: Record<string, string> = {
			semicolon: `a.txt;${secret}`,
			comma: `a.txt,${secret}`,
			brace: `{a.txt,${secret}}`,
			backslash: `a\\{b,${secret},c}`,
			"percent-escape": `a.txt%3B${secret}`,
			"file URL": `file://${hostDir}/a.txt%3B${secret}`,
		};
		const asCall: Record<string, (p: string) => ScriptedCall> = {
			read: p => call("read", { path: p }),
			grep: p => call("grep", { pattern: "SECRET", path: p }),
			glob: p => call("glob", { path: p }),
			write: p => call("write", { path: p, content: "planted" }),
			edit: p => call("edit", { input: `[${p}#ABCD]\nPUT 1.=1:\n+planted` }),
		};
		const cases = Object.entries(classes).flatMap(([kind, p]) => Object.entries(asCall).map(([tool, make]) => ({ kind, tool, call: make(p) })));
		// Plain single paths, a name with a space, a glob and an internal URL keep working.
		const plain = [
			call("read", { path: "a.txt" }),
			call("read", { path: "sub dir/b c.txt" }),
			call("grep", { pattern: "inside", path: "sub dir" }),
			call("glob", { path: "sub dir/*.txt" }),
			call("write", { path: "new.txt", content: "made\n" }),
		];
		const run = await runOmp([...cases.map(c => c.call), ...plain], {}, { "a.txt": "inside A\n", "sub dir/b c.txt": "inside B\n" }, hostDir);
		const byId = new Map(run.ends.map(end => [end.toolCallId, end]));
		cases.forEach(({ kind, tool }, index) => {
			const end = byId.get(`call_${index}`);
			expect({ kind, tool, isError: end?.isError }).toEqual({ kind, tool, isError: true });
			expect(end?.text).toContain("one plain path per call");
			expect(end?.text).not.toContain("HOST-ONLY-SECRET");
		});
		const results = plain.map((_, index) => byId.get(`call_${cases.length + index}`));
		expect(results.map(end => end?.isError)).toEqual([false, false, false, false, false]);
		expect(results[0]?.text).toContain("inside A");
		expect(results[1]?.text).toContain("inside B");
		expect(results[2]?.text).toContain("b c.txt");
		expect(results[3]?.text).toContain("b c.txt");
		expect(await fs.readFile(path.join(run.sandboxDir, "new.txt"), "utf8")).toBe("made\n");
		expect(await fs.readdir(outside)).toEqual(["secret.txt"]);
		expect(await fs.readFile(secret, "utf8")).toBe("HOST-ONLY-SECRET");
	}, 180_000);

	test("an interactive approval prompt shows the command the agent wrote, as for native bash, and its answer is followed", async () => {
		// RPC mode with always-ask: each bash call raises omp's approval prompt.
		const agentDir = path.join(scratch, "agent-always-ask");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), "tools:\n  approvalMode: always-ask\n");
		const script = JSON.stringify([bash({ command: "touch approve-me" }), bash({ command: "touch deny-me" })]);
		const drive = async (withExtension: boolean) => {
			const hostDir = await freshHostDir();
			const sandboxDir = await freshSandbox();
			const extensions = ["--trusted-extension", path.join(import.meta.dir, "fixtures/scripted-provider.ts")];
			if (withExtension) extensions.push("--trusted-extension", path.resolve(import.meta.dir, "../src/extension.ts"));
			const child = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "fixtures/rpc-approver.ts"), OMP, hostDir, ...extensions, "--model", "scripted/scripted-1", "--no-session"],
				{
					env: {
						HOME: path.join(scratch, "home"),
						PATH: "/usr/local/bin:/usr/bin:/bin",
						TERM: "dumb",
						PI_CODING_AGENT_DIR: agentDir,
						PI_CONFIG_DIR: path.join(scratch, "config"),
						OMP_SANDBOX_SCRIPT: script,
						OMP_SANDBOX_BACKEND: "local",
						OMP_SANDBOX_LOCAL_ROOT: sandboxDir,
					},
					stdout: "pipe",
					stderr: "ignore",
				},
			);
			const lines = (await new Response(child.stdout).text()).split("\n").filter(Boolean).map(line => JSON.parse(line) as { prompt?: string; end?: string; isError?: boolean });
			await child.exited;
			return {
				prompts: lines.flatMap(line => (line.prompt === undefined ? [] : [line.prompt])),
				ends: lines.flatMap(line => (line.end === undefined ? [] : [{ id: line.end, isError: line.isError }])),
				hostDir,
				sandboxDir,
			};
		};
		const native = await drive(false);
		const shadow = await drive(true);
		expect(native.prompts).toEqual(["Allow tool: bash\nCommand: touch approve-me", "Allow tool: bash\nCommand: touch deny-me"]);
		expect(shadow.prompts).toEqual(native.prompts);
		expect(shadow.ends).toEqual([
			{ id: "call_0", isError: false },
			{ id: "call_1", isError: true },
		]);
		expect(await fs.readdir(shadow.sandboxDir)).toEqual(expect.arrayContaining(["approve-me"]));
		expect(await fs.readdir(shadow.sandboxDir)).not.toContain("deny-me");
	}, 180_000);

	test("in one batch, each call sees what the call before it did", async () => {
		const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
		const run = await runOmp([
			// One assistant message: omp prepares all four calls before running any.
			[
				bash({ command: "echo from-bash > made.txt" }),
				call("read", { path: "made.txt" }),
				call("write", { path: "w.txt", content: "from-write\n" }),
				bash({ command: "cat w.txt" }),
			],
		]);
		const byId = new Map(run.ends.map(end => [end.toolCallId, end]));
		for (const id of ["call_0", "call_1", "call_2", "call_3"]) expect(byId.get(id)?.isError).toBe(false);
		expect(byId.get("call_1")?.text).toContain("from-bash");
		expect(byId.get("call_3")?.text).toContain("from-write");
	}, 120_000);

	test("once a sync fails, later calls in the same batch are refused when they run, not only when prepared", async () => {
		const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
		const run = await runOmp(
			[
				[
					// Removing the sandbox's root makes this call's own pull afterwards fail.
					bash({ command: 'root="$PWD"; cd / && rm -rf -- "$root"' }),
					call("write", { path: "first.txt", content: "must not be written\n" }),
					call("read", { path: "keep.txt" }),
					bash({ command: "touch /tmp/omp-sandbox-must-not-run" }),
				],
			],
			{},
			{ "keep.txt": "k\n" },
		);
		const byId = new Map(run.ends.map(end => [end.toolCallId, end]));
		const text = (id: string) => byId.get(id)?.text ?? "";
		expect(byId.get("call_0")?.isError).toBe(true);
		expect(text("call_0")).toContain("its changes did not reach the workspace copy");
		// All prepared before the failure; each refused when it came to run.
		for (const id of ["call_1", "call_2", "call_3"]) {
			expect(byId.get(id)?.isError).toBe(true);
			expect(text(id)).toContain("out of sync");
		}
		expect(await fs.readdir(run.hostDir)).not.toContain("first.txt");
		expect(await Bun.file("/tmp/omp-sandbox-must-not-run").exists()).toBe(false);
	}, 120_000);

	test("a model-specific edit variant gives the shadow the same contract as native edit", async () => {
		// edit.modelVariants picks replace-mode edit for the scripted model; the shadow's schema and the
		// native tool it runs must follow the session's model, not a default.
		const agentDir = path.join(scratch, "agent-replace-edit");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), "async:\n  printWake: true\nedit:\n  modelVariants:\n    scripted: replace\n");
		const run = await runOmp(
			[{ name: "edit", arguments: { path: "r.txt", old_string: "before", new_string: "after" } }],
			{ PI_CODING_AGENT_DIR: agentDir },
			{ "r.txt": "before\n" },
		);
		expect(run.ends[0]?.isError).toBe(false);
		expect(await fs.readFile(path.join(run.sandboxDir, "r.txt"), "utf8")).toBe("after\n");
	}, 120_000);

	test("read's documentation topics work through the shadow", async () => {
		const run = await runOmp([{ name: "read", arguments: { path: "xd://read/sources" } }]);
		expect(run.ends[0]?.isError).toBe(false);
		expect(run.ends[0]?.text).not.toContain("has no doc topics");
		expect(run.ends[0]?.text.length).toBeGreaterThan(200);
	}, 120_000);

	test("a host copy that is not empty at start refuses bash and the file tools", async () => {
		const hostDir = await freshHostDir();
		await fs.writeFile(path.join(hostDir, "stray.txt"), "x");
		const child = Bun.spawn(
			[OMP, "--trusted-extension", path.join(import.meta.dir, "fixtures/scripted-provider.ts"), "--trusted-extension", path.resolve(import.meta.dir, "../src/extension.ts"), "--model", "scripted/scripted-1", "--no-session", "--mode", "json", "-p", "go"],
			{
				cwd: hostDir,
				env: {
					HOME: path.join(scratch, "home"),
					PATH: "/usr/local/bin:/usr/bin:/bin",
					TERM: "dumb",
					PI_CODING_AGENT_DIR: path.join(scratch, "agent"),
					PI_CONFIG_DIR: path.join(scratch, "config"),
					OMP_SANDBOX_SCRIPT: JSON.stringify([bash({ command: "true" }), { name: "read", arguments: { path: "stray.txt" } }]),
					OMP_SANDBOX_BACKEND: "local",
					OMP_SANDBOX_LOCAL_ROOT: await freshSandbox(),
				},
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const stdout = await new Response(child.stdout).text();
		await child.exited;
		const ends = stdout
			.split("\n")
			.filter(line => line.includes('"tool_execution_end"'))
			.map(line => JSON.parse(line) as { isError?: boolean; result?: { content?: { text?: string }[] } });
		expect(ends).toHaveLength(2);
		for (const end of ends) {
			expect(end.isError).toBe(true);
			expect((end.result?.content ?? []).map(c => c.text ?? "").join("")).toContain("must start empty");
		}
	}, 120_000);
});

function stripDescriptions(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(stripDescriptions);
	if (schema === null || typeof schema !== "object") return schema;
	return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "description").map(([key, value]) => [key, stripDescriptions(value)]));
}
