/**
 * omp-sandbox: an omp extension that runs the agent's `bash` in a sandbox.
 *
 * It re-registers the built-in `bash` under the same name and parameters. A
 * call is not executed here: the command is rewritten into the backend's
 * host command line (Backend.shellCommand) and handed back to omp's native
 * bash through `ctx.invokeTool`, so omp's background jobs, auto-backgrounding,
 * timeouts, streaming and exit-code reporting keep working unchanged.
 *
 * Configuration (environment of the omp process):
 *   OMP_SANDBOX_BACKEND           "local" (tests); unset = extension inactive
 *   OMP_SANDBOX_LOCAL_ROOT        local backend: the directory that is the sandbox
 *   OMP_SANDBOX_LOCAL_CONTAINMENT local backend: "full" or "process-tree" (default: best available)
 *   OMP_SANDBOX_HOST_ROOT         the host workspace mapped onto the sandbox root (default: omp's cwd)
 *
 * Approval: each call is judged by omp's own bash approval rules
 * (`bash.patterns` allow/prompt/deny, the bash interceptor, critical-command
 * prompts) against the command the agent wrote, not the rewritten one; the
 * delegated native call is not gated again.
 *
 * Fail closed: when configured but the backend cannot be set up, or omp's bash
 * approval rules cannot be loaded, `bash` refuses every call instead of
 * running on the host.
 *
 * Step 2a scope: only `bash` moves. read/edit/write/grep/glob/find still act
 * on host files until step 2b; do not use this for a live agent yet.
 */
import type { ApprovalContext, ToolApprovalDecision, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Backend } from "./backend.ts";
import { LocalBackend } from "./local-backend.ts";
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
	approve: BashApproval;
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
			if (setup === undefined) throw new Error(unavailable());
			if (params.pty === true) {
				throw new Error("omp-sandbox: `pty` is not supported in the sandbox (it would run on this machine)");
			}
			if ((params.name ?? "").trim() !== "" || params.ready !== undefined) {
				throw new Error("omp-sandbox: named services (`name`/`ready`) are not supported in the sandbox");
			}
			if (ctx.invokeTool === undefined) {
				throw new Error("omp-sandbox: omp's native bash is not available to delegate to");
			}
			const cwd = setup.paths.toSandbox(params.cwd ?? ".", ctx.cwd);
			const command = setup.backend.shellCommand(params.command, { cwd });
			const native: Record<string, unknown> = { command };
			if (params.timeout !== undefined) native.timeout = params.timeout;
			if (params.async !== undefined) native.async = params.async;
			return ctx.invokeTool(native, { signal, onUpdate });
		},
	});
}

async function createSetup(kind: string): Promise<SandboxSetup> {
	const approve = await loadBashApproval();
	const hostRoot = process.env.OMP_SANDBOX_HOST_ROOT || process.cwd();
	if (kind === "local") {
		const root = process.env.OMP_SANDBOX_LOCAL_ROOT;
		if (root === undefined || root === "") throw new Error("OMP_SANDBOX_LOCAL_ROOT is not set");
		const containment = process.env.OMP_SANDBOX_LOCAL_CONTAINMENT;
		if (containment !== undefined && containment !== "" && containment !== "full" && containment !== "process-tree") {
			throw new Error(`OMP_SANDBOX_LOCAL_CONTAINMENT must be "full" or "process-tree", not ${containment}`);
		}
		const backend = await LocalBackend.create(root, containment ? { containment } : {});
		return { backend, paths: new PathMap(hostRoot, backend.root), approve };
	}
	throw new Error(`unknown OMP_SANDBOX_BACKEND ${kind}`);
}

/**
 * omp's own bash approval decision, bound to the calling session's settings
 * (`ctx.settings`; the process settings when a caller passes no context, which
 * omp's main session shares). omp's BashTool reads nothing but settings for
 * its approval, so one is built per settings object. Loaded dynamically so a
 * moved module refuses bash (setup error) rather than failing the extension
 * load and leaving omp's host bash in place.
 */
async function loadBashApproval(): Promise<BashApproval> {
	let modules: [typeof import("@oh-my-pi/pi-coding-agent/tools/bash"), typeof import("@oh-my-pi/pi-coding-agent/config/settings")];
	try {
		modules = await Promise.all([import("@oh-my-pi/pi-coding-agent/tools/bash"), import("@oh-my-pi/pi-coding-agent/config/settings")]);
	} catch (error) {
		throw new Error(`cannot load omp's bash approval rules: ${error instanceof Error ? error.message : String(error)}`);
	}
	const [{ BashTool }, { Settings }] = modules;
	if (typeof BashTool !== "function" || typeof Settings !== "function") throw new Error("cannot load omp's bash approval rules: BashTool or Settings missing");
	const bySettings = new WeakMap<object, InstanceType<typeof BashTool>>();
	return (args, ctx) => {
		const settings = ctx?.settings ?? Settings.instance;
		let tool = bySettings.get(settings);
		if (tool === undefined) {
			tool = new BashTool({ settings });
			bySettings.set(settings, tool);
		}
		return tool.approval(args, ctx);
	};
}
