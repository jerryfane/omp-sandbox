/**
 * omp-sandbox: an omp extension that moves the agent's workspace into a sandbox.
 *
 * bash: it re-registers the built-in `bash` under the same name and
 * parameters. A call is not executed here: the command is rewritten into the
 * backend's host command line (Backend.shellCommand) and handed back to omp's
 * native bash through `ctx.invokeTool`, so omp's background jobs,
 * auto-backgrounding, timeouts, streaming and exit-code reporting keep working.
 *
 * File tools (read, write, edit, grep, glob, find, ast_grep): omp's
 * own tools, unchanged, on a host copy of the sandbox's workspace (a Mirror),
 * which is omp's cwd. The copy is brought up to date before each file-tool
 * call and after each bash call, and what the tools change is sent to the
 * sandbox after each file-tool call and before each bash call. A file-tool
 * call that names a path outside the copy is refused, judged with omp's own
 * reading of the tool's arguments.
 *
 * Refused outright: eval, debug, lsp and task, which run code on this
 * machine, and ast_edit, whose paths omp does not report.
 *
 * Configuration (environment of the omp process):
 *   OMP_SANDBOX_BACKEND           "local" (tests); unset = extension inactive
 *   OMP_SANDBOX_LOCAL_ROOT        local backend: the directory that is the sandbox
 *   OMP_SANDBOX_LOCAL_CONTAINMENT local backend: "full" or "process-tree" (default: best available)
 * omp's cwd is the host copy and must be an empty directory when omp starts.
 *
 * Approval: each call is judged by omp's own bash approval rules
 * (`bash.patterns` allow/prompt/deny, the bash interceptor, critical-command
 * prompts) against the command the agent wrote, not the rewritten one; the
 * delegated native call is not gated again.
 *
 * Fail closed: when configured but the backend cannot be set up, omp's bash
 * approval rules or file-tool parsers cannot be loaded, or a sync fails,
 * `bash` and the file tools refuse every call instead of acting on the host.
 */
import type { ApprovalContext, ExtensionAPI, OmpSettings, ToolApprovalDecision, ToolResultContent } from "@oh-my-pi/pi-coding-agent";
import type { Backend } from "./backend.ts";
import { isFileTool, loadTargetParsers, refuseFileCall, refusedToolReason, type TargetParsers } from "./file-tools.ts";
import { LocalBackend } from "./local-backend.ts";
import { Mirror } from "./mirror.ts";
import { PathMap } from "./path-map.ts";

type BashApproval = (args: unknown, ctx?: ApprovalContext) => ToolApprovalDecision;

const TOOL_DESCRIPTION = `Run a bash command in the sandbox: the workspace's files, builds and tests live there, not on this machine.
Paths inside the workspace work as usual; anything outside it does not exist in the sandbox.
\`cwd\` must be inside the workspace. \`async: true\` runs the command as a background job.
Not available here: \`pty\` and named services (\`name\`/\`ready\`), which would run on this machine.`;

/** The built-in bash's parameters (omp 18.20), as the model sends them. */
interface BashParams {
	command: string;
	timeout?: number;
	cwd?: string;
	pty?: boolean;
	async?: boolean;
	name?: string;
	ready?: { log?: string; port?: number; host?: string; timeout?: number };
}

interface SandboxSetup {
	backend: Backend;
	paths: PathMap;
	mirror: Mirror;
	parsers: TargetParsers;
	approve: BashApproval;
	/** The process settings: what omp's main session uses, for parsing file-tool targets. */
	settings: () => OmpSettings;
}

export default async function ompSandbox(pi: ExtensionAPI): Promise<void> {
	const kind = process.env.OMP_SANDBOX_BACKEND;
	if (kind === undefined || kind === "") return;

	let setup: SandboxSetup | undefined;
	let setupError: string | undefined;
	try {
		setup = await createSetup(kind);
	} catch (error) {
		setupError = error instanceof Error ? error.message : String(error);
	}
	const unavailable = () => `omp-sandbox: the ${kind} sandbox is not available (${setupError}); refusing to run on this machine`;
	/** The setup, or why no call may run now: setup failed, or the copy is out of sync. */
	const usable = (): SandboxSetup | string => {
		if (setup === undefined) return unavailable();
		const broken = setup.mirror.broken;
		return broken === undefined ? setup : `omp-sandbox: ${broken}; refusing to run`;
	};

	pi.on("tool_call", async event => {
		const refusedReason = refusedToolReason(event.toolName);
		if (refusedReason !== undefined) {
			return { block: true, reason: `omp-sandbox: ${event.toolName} is not available with the sandbox: it ${refusedReason}` };
		}
		if (!isFileTool(event.toolName)) return undefined;
		const ready = usable();
		if (typeof ready === "string") return { block: true, reason: ready };
		try {
			const refused = refuseFileCall(ready.parsers, event.toolName, event.input, ready.mirror.hostRoot, process.cwd(), ready.settings());
			if (refused !== undefined) return { block: true, reason: refused };
			// Picks up what background bash jobs changed. In a batch this runs
			// before any call of the batch; each bash call pulls again itself.
			await ready.mirror.pullRemote();
		} catch (error) {
			return { block: true, reason: `omp-sandbox: ${errorMessage(error)}` };
		}
		return undefined;
	});

	pi.on("tool_result", async event => {
		if (setup === undefined || !isFileTool(event.toolName)) return undefined;
		try {
			await setup.mirror.pushLocal();
		} catch (error) {
			return { isError: true, content: [...event.content, notice(`omp-sandbox: this change did not reach the sandbox: ${errorMessage(error)}`)] };
		}
		return undefined;
	});

	const z = pi.zod;
	pi.registerTool<BashParams>({
		name: "bash",
		label: "Bash (sandbox)",
		description: TOOL_DESCRIPTION,
		// The built-in bash's parameters (omp 18.20). Mirrored by hand because
		// an extension cannot read the native schema at load time; a test
		// compares the schema omp sends the model with and without this tool.
		parameters: z.object({
			command: z.string(),
			timeout: z.number().optional(),
			cwd: z.string().optional(),
			pty: z.boolean().optional(),
			async: z.boolean().optional(),
			name: z.string().max(48).optional(),
			ready: z
				.object({
					log: z.string().optional(),
					port: z.number().optional(),
					host: z.string().optional(),
					timeout: z.number().optional(),
				})
				.optional(),
		}),
		loadMode: "essential",
		approval: (args, ctx) => {
			if (setup === undefined) return { tier: "exec", override: true, policy: "deny", reason: unavailable() };
			try {
				return setup.approve(args, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { tier: "exec", override: true, policy: "deny", reason: `omp-sandbox: omp's bash approval rules failed (${message})` };
			}
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const ready = usable();
			if (typeof ready === "string") throw new Error(ready);
			if (params.pty === true) {
				throw new Error("omp-sandbox: `pty` is not supported in the sandbox (it would run on this machine)");
			}
			if ((params.name ?? "").trim() !== "" || params.ready !== undefined) {
				throw new Error("omp-sandbox: named services (`name`/`ready`) are not supported in the sandbox");
			}
			if (ctx.invokeTool === undefined) {
				throw new Error("omp-sandbox: omp's native bash is not available to delegate to");
			}
			const cwd = ready.paths.toSandbox(params.cwd ?? ".", ctx.cwd);
			const command = ready.backend.shellCommand(params.command, { cwd });
			const native: Record<string, unknown> = { command };
			if (params.timeout !== undefined) native.timeout = params.timeout;
			if (params.async !== undefined) native.async = params.async;
			await ready.mirror.pushLocal();
			const result = await ctx.invokeTool(native, { signal, onUpdate });
			try {
				await ready.mirror.pullRemote();
			} catch (error) {
				return { ...result, isError: true, content: [...result.content, notice(`omp-sandbox: the command ran, but its changes did not reach the workspace copy: ${errorMessage(error)}`)] };
			}
			return result;
		},
	});
}

function notice(text: string): ToolResultContent {
	return { type: "text", text: `\n${text}` };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function createSetup(kind: string): Promise<SandboxSetup> {
	const { approve, settings } = await loadBashApproval();
	const parsers = await loadTargetParsers(process.cwd(), settings());
	let backend: Backend;
	if (kind === "local") {
		const root = process.env.OMP_SANDBOX_LOCAL_ROOT;
		if (root === undefined || root === "") throw new Error("OMP_SANDBOX_LOCAL_ROOT is not set");
		const containment = process.env.OMP_SANDBOX_LOCAL_CONTAINMENT;
		if (containment !== undefined && containment !== "" && containment !== "full" && containment !== "process-tree") {
			throw new Error(`OMP_SANDBOX_LOCAL_CONTAINMENT must be "full" or "process-tree", not ${containment}`);
		}
		backend = await LocalBackend.create(root, containment ? { containment } : {});
	} else {
		throw new Error(`unknown OMP_SANDBOX_BACKEND ${kind}`);
	}
	try {
		const mirror = await Mirror.create(backend, process.cwd());
		await mirror.pullRemote();
		return { backend, paths: new PathMap(mirror.hostRoot, backend.root), mirror, parsers, approve, settings };
	} catch (error) {
		await backend.close();
		throw error;
	}
}

/**
 * omp's own bash approval decision, bound to the calling session's settings
 * (`ctx.settings`; the process settings when a caller passes no context, which
 * omp's main session shares). omp's BashTool reads nothing but settings for
 * its approval, so one is built per settings object. Loaded dynamically so a
 * moved module refuses bash (setup error) rather than failing the extension
 * load and leaving omp's host bash in place.
 */
async function loadBashApproval(): Promise<{ approve: BashApproval; settings: () => OmpSettings }> {
	let modules: [typeof import("@oh-my-pi/pi-coding-agent/tools/bash"), typeof import("@oh-my-pi/pi-coding-agent/config/settings")];
	try {
		modules = await Promise.all([import("@oh-my-pi/pi-coding-agent/tools/bash"), import("@oh-my-pi/pi-coding-agent/config/settings")]);
	} catch (error) {
		throw new Error(`cannot load omp's bash approval rules: ${errorMessage(error)}`);
	}
	const [{ BashTool }, { Settings }] = modules;
	if (typeof BashTool !== "function" || typeof Settings !== "function") throw new Error("cannot load omp's bash approval rules: BashTool or Settings missing");
	const bySettings = new WeakMap<object, InstanceType<typeof BashTool>>();
	const approve: BashApproval = (args, ctx) => {
		const settings = ctx?.settings ?? Settings.instance;
		let tool = bySettings.get(settings);
		if (tool === undefined) {
			tool = new BashTool({ settings });
			bySettings.set(settings, tool);
		}
		return tool.approval(args, ctx);
	};
	return { approve, settings: () => Settings.instance };
}
