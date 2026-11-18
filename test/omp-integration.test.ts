// Runs the installed omp headless with the real extension and a scripted
// provider (no model, no spend), against LocalBackend. Skipped when omp is
// not installed. Everything omp writes goes to a throwaway agent dir and HOME.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const OMP = process.env.OMP_BIN ?? "/root/.local/bin/omp";
const ompInstalled = await Bun.file(OMP).exists();

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
}

let scratch: string;
let sandboxDir: string;
let hostDir: string;

beforeAll(async () => {
	scratch = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-omp-"));
	sandboxDir = path.join(scratch, "sandbox");
	hostDir = path.join(scratch, "host-workspace");
	for (const dir of [sandboxDir, hostDir, path.join(scratch, "agent"), path.join(scratch, "home")]) {
		await fs.mkdir(dir, { recursive: true });
	}
	await fs.mkdir(path.join(sandboxDir, "sub"));
	// async.enabled is on by default; print mode needs printWake to deliver job results.
	await fs.writeFile(path.join(scratch, "agent/config.yml"), "async:\n  printWake: true\n");
});

afterAll(async () => {
	await fs.rm(scratch, { recursive: true, force: true });
});

/** Runs omp once with the given script of tool calls; returns what the session did. */
async function runOmp(script: { name: string; arguments: Record<string, unknown> }[], extraEnv: Record<string, string> = {}): Promise<Run> {
	const dir = import.meta.dir;
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
				OMP_SANDBOX_HOST_ROOT: hostDir,
				OMP_SANDBOX_TEST_HOST_SECRET: "must-not-leak",
				...extraEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	const run: Run = { ends: [], asyncResults: [], finalText: "", exitCode, stderr };
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

function bash(args: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } {
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

		expect(byId.get("call_0")?.text).toContain(`${sandboxDir}\nsecret=[]`);
		expect(byId.get("call_1")?.text).toContain(path.join(sandboxDir, "sub"));
		expect(await Bun.file(path.join(sandboxDir, "made-in-sandbox")).exists()).toBe(true);
		expect(await fs.readdir(hostDir)).toEqual([]);

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
		expect(await fs.readdir(hostDir)).toEqual([]);
	}, 120_000);

	test("the shadow bash declares the same parameters as omp's native bash", async () => {
		// The extension mirrors the schema by hand (it cannot read it at load
		// time); this catches a drift when omp's bash gains or drops a field.
		const probe = path.join(scratch, "schema-probe.ts");
		await fs.writeFile(
			probe,
			`export default function (pi) { pi.on("session_start", async () => { const t = pi.getAllTools().find(x => x.name === "bash"); process.stderr.write("BASH-EXPR " + t.parameters.expression + "\\n"); }); }\n`,
		);
		const child = Bun.spawn(
			[OMP, "--trusted-extension", path.join(import.meta.dir, "fixtures/scripted-provider.ts"), "--trusted-extension", probe, "--model", "scripted/scripted-1", "--no-session", "-p", "go"],
			{
				cwd: hostDir,
				env: { HOME: path.join(scratch, "home"), PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "dumb", PI_CODING_AGENT_DIR: path.join(scratch, "agent"), PI_CONFIG_DIR: path.join(scratch, "config"), OMP_SANDBOX_SCRIPT: "[]" },
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		const stderr = await new Response(child.stderr).text();
		await child.exited;
		const expression = stderr.split("\n").find(l => l.startsWith("BASH-EXPR "))?.slice("BASH-EXPR ".length) ?? "";
		const native = [...expression.replace(/ready\?: \{[^}]*\}/, "ready?: {}").matchAll(/(\w+)\??:/g)].map(m => m[1]).sort();
		expect(native).toEqual(["async", "command", "cwd", "name", "pty", "ready", "timeout"]);
	}, 120_000);
});
