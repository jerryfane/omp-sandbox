/**
 * omp-sandbox: an omp extension that moves the agent's workspace into a sandbox.
 *
 * bash: it re-registers the built-in `bash` under the same name and
 * parameters. A call is not executed here: the command is rewritten into the
 * backend's host command line (Backend.shellCommand) and handed back to omp's
 * native bash through `ctx.invokeTool`, so omp's background jobs,
 * auto-backgrounding, timeouts, streaming and exit-code reporting keep working.
 *
 * File tools (read, write, edit, grep, glob, find, ast_grep): each is
 * re-registered too, as a shadow of omp's own tool that takes its schema,
 * description and approval from an instance of omp's tool class. The native
 * tool runs, through `ctx.invokeTool`, on a host copy of the sandbox's
 * workspace (a Mirror), which is omp's cwd.
 *
 * Every shadow does its checks and syncs inside its own execution, so they
 * hold for each call even in a batch the model sent at once:
 *   - a file tool: refuse if the copy is out of sync or the call names a path
 *     outside it (judged by the native tool's own reading of its arguments),
 *     pull, run the native tool, push;
 *   - bash: refuse if out of sync, push, run in the sandbox, pull.
 * All shadows are exclusive (omp runs them one at a time), so no two syncs or
 * tool runs interleave.
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
 * Approval: each bash call is judged by omp's own bash approval rules
 * (`bash.patterns` allow/prompt/deny, the bash interceptor, critical-command
 * prompts) against the command the agent wrote, not the rewritten one, and
 * its prompt shows that command. A file tool's approval is its native one.
 * The delegated native call is not gated again.
 *
 * Fail closed: when configured but omp's modules cannot be loaded, the
 * backend cannot be set up, or a sync fails, `bash` and the file tools refuse
 * every call instead of acting on the host.
 */
import type {
	AgentToolResult,
	ApprovalContext,
	ExtensionAPI,
	NativeFileTool,
	OmpSettings,
	OmpModel,
	SessionEventContext,
	ToolApprovalDecision,
	ToolDefinition,
	ToolResultContent,
} from "@oh-my-pi/pi-coding-agent";
import type { Backend } from "./backend.ts";
import { type FileToolName, isFileTool, type LoadedFileTool, loadFileTools, refuseFileCall, refusedToolReason } from "./file-tools.ts";
import { LocalBackend } from "./local-backend.ts";
import { Mirror } from "./mirror.ts";
import { PathMap } from "./path-map.ts";

type BashApproval = (args: unknown, ctx?: ApprovalContext) => ToolApprovalDecision;
type BashApprovalDetails = (args: unknown) => string[];

const TOOL_DESCRIPTION = `Run a bash command in the sandbox: the workspace's files, builds and tests live there, not on this machine.
Paths inside the workspace work as usual; anything outside it does not exist in the sandbox.
\`cwd\` must be inside the workspace. \`async: true\` runs the command as a background job.
Not available here: \`pty\` and named services (\`name\`/\`ready\`), which would run on this machine.`;

/**
 * The native file-tool members a shadow forwards: what the model and the
 * approval gate see. Members that let a call act outside `execute`
 * (openArgStream, speculation, matcher*, completeImageRequest) are not
 * forwarded, so every effect goes through the shadow's checks.
 */
const FORWARDED = ["label", "description", "parameters", "loadMode", "strict", "summary", "examples", "mode", "customFormat", "customWireName", "readsSkillUris"] as const;
/** Forwarded methods, called on the native instance. `docTopics` is read's documentation (xd://read/…), no file access. */
const FORWARDED_METHODS = ["approvalCacheTargets", "formatApprovalDetails", "docTopics"] as const;

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

/** What comes from omp itself; without it no shadow can be built. */
interface Natives {
	approve: BashApproval;
	approvalDetails: BashApprovalDetails;
	fileTools: ReadonlyMap<FileToolName, LoadedFileTool>;
}

interface Sandbox {
	backend: Backend;
	paths: PathMap;
	mirror: Mirror;
}

export default async function ompSandbox(pi: ExtensionAPI): Promise<void> {
	const kind = process.env.OMP_SANDBOX_BACKEND;
	if (kind === undefined || kind === "") return;

	// The session's current model, kept current from session events: the native
	// file tools pick their contract from it (edit's mode and description follow
	// `edit.modelVariants`), and the native instance a shadow delegates to
	// reads the same model, so both must agree.
	let currentModel: OmpModel | undefined;
	const trackModel = async (_event: unknown, ctx: SessionEventContext) => {
		if (ctx.model !== undefined) currentModel = ctx.model;
	};
	pi.on("session_start", trackModel);
	pi.on("before_agent_start", trackModel);
	pi.on("turn_start", trackModel);

	let natives: Natives | undefined;
	let sandbox: Sandbox | undefined;
	let setupError: string | undefined;
	try {
		natives = await loadNatives(process.cwd(), () => currentModel);
		sandbox = await createSandbox(kind);
	} catch (error) {
		setupError = errorMessage(error);
	}
	/** The sandbox, or why no call may run now: setup failed, or the copy is out of sync. */
	const usable = (): Sandbox | string => {
		if (sandbox === undefined) return `omp-sandbox: the ${kind} sandbox is not available (${setupError}); refusing to run on this machine`;
		const broken = sandbox.mirror.broken;
		return broken === undefined ? sandbox : `omp-sandbox: ${broken}; refusing to run`;
	};

	// An early refusal, before any approval prompt: calls that cannot run.
	// The shadows check again when each call actually runs.
	pi.on("tool_call", async event => {
		const refusedReason = refusedToolReason(event.toolName);
		if (refusedReason !== undefined) {
			return { block: true, reason: `omp-sandbox: ${event.toolName} is not available with the sandbox: it ${refusedReason}` };
		}
		if (event.toolName !== "bash" && !isFileTool(event.toolName)) return undefined;
		const ready = usable();
		if (typeof ready === "string") return { block: true, reason: ready };
		const native = isFileTool(event.toolName) ? natives?.fileTools.get(event.toolName)?.native : undefined;
		if (native !== undefined) {
			const refused = refuseFileCall(native, event.toolName, event.input, ready.mirror.hostRoot);
			if (refused !== undefined) return { block: true, reason: refused };
		}
		return undefined;
	});

	// Every file tool is shadowed, so none of omp's runs unsupervised on the copy. One
	// omp's settings do not offer (find, ast_grep by default) is registered inactive.
	for (const [name, { native, allowed }] of natives?.fileTools ?? []) pi.registerTool(fileShadow(name, native, allowed, usable));

	const z = pi.zod;
	pi.registerTool<BashParams>({
		name: "bash",
		label: "Bash (sandbox)",
		description: TOOL_DESCRIPTION,
		// The built-in bash's parameters (omp 18.20). Mirrored by hand because
		// omp's bash schema depends on live settings; a test compares the
		// schema omp sends the model with and without this tool.
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
		concurrency: "exclusive",
		approval: (args, ctx) => {
			if (natives === undefined) return { tier: "exec", override: true, policy: "deny", reason: `omp-sandbox: ${setupError}` };
			try {
				return natives.approve(args, ctx);
			} catch (error) {
				return { tier: "exec", override: true, policy: "deny", reason: `omp-sandbox: omp's bash approval rules failed (${errorMessage(error)})` };
			}
		},
		// Without this the prompt says only "Allow tool: bash", without the command.
		formatApprovalDetails: args => {
			if (natives !== undefined) return natives.approvalDetails(args);
			const command = (args as { command?: unknown } | undefined)?.command;
			return [`Command: ${typeof command === "string" ? command : "(missing)"}`];
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
				return withError(result, `omp-sandbox: the command ran, but its changes did not reach the workspace copy: ${errorMessage(error)}`);
			}
			return result;
		},
	});
}

/**
 * A shadow of omp's file tool `name`: the native tool's schema, description
 * and approval, with the sandbox's checks and syncs around each run.
 */
function fileShadow(name: FileToolName, native: NativeFileTool, allowed: boolean, usable: () => Sandbox | string): ToolDefinition<Record<string, unknown>> {
	const shadow: ToolDefinition<Record<string, unknown>> = {
		name,
		label: native.label,
		description: native.description,
		parameters: native.parameters,
		concurrency: "exclusive",
		defaultInactive: !allowed,
		approval: typeof native.approval === "function" ? (args, ctx) => (native.approval as BashApproval)(args, ctx) : (native.approval ?? "exec"),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const ready = usable();
			if (typeof ready === "string") throw new Error(ready);
			const refused = refuseFileCall(native, name, params, ready.mirror.hostRoot);
			if (refused !== undefined) throw new Error(refused);
			if (ctx.invokeTool === undefined) throw new Error(`omp-sandbox: omp's native ${name} is not available to delegate to`);
			// Picks up what background bash jobs changed since the last sync.
			await ready.mirror.pullRemote();
			const result = await ctx.invokeTool(params, { signal, onUpdate });
			try {
				await ready.mirror.pushLocal();
			} catch (error) {
				return withError(result, `omp-sandbox: this change did not reach the sandbox: ${errorMessage(error)}`);
			}
			return result;
		},
	};
	// Live getters: the native values can depend on settings.
	for (const key of FORWARDED) {
		if (!(key in native)) continue;
		Object.defineProperty(shadow, key, { get: () => (native as unknown as Record<string, unknown>)[key], enumerable: true, configurable: true });
	}
	for (const key of FORWARDED_METHODS) {
		const method = (native as unknown as Record<string, unknown>)[key];
		if (typeof method === "function") Object.defineProperty(shadow, key, { value: (...args: unknown[]) => method.apply(native, args), enumerable: true, configurable: true });
	}
	return shadow;
}

function withError<T extends AgentToolResult>(result: T, text: string): T {
	return { ...result, isError: true, content: [...result.content, notice(text)] };
}

function notice(text: string): ToolResultContent {
	return { type: "text", text: `\n${text}` };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** omp's own pieces the shadows are built from. */
async function loadNatives(cwd: string, model: () => OmpModel | undefined): Promise<Natives> {
	const { approve, approvalDetails, settings } = await loadBashApproval();
	const fileTools = await loadFileTools({
		cwd,
		settings,
		getActiveModel: model,
		getActiveModelString: () => {
			const current = model();
			return current === undefined ? undefined : `${current.provider}/${current.id}`;
		},
	});
	return { approve, approvalDetails, fileTools };
}

async function createSandbox(kind: string): Promise<Sandbox> {
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
		return { backend, paths: new PathMap(mirror.hostRoot, backend.root), mirror };
	} catch (error) {
		await backend.close();
		throw error;
	}
}

/**
 * omp's own bash approval decision and prompt rows, bound to the calling
 * session's settings (`ctx.settings`; the process settings when a caller
 * passes no context, which omp's main session shares). omp's BashTool reads
 * nothing but settings for these, so one is built per settings object.
 * Loaded dynamically so a moved module refuses bash (setup error) rather than
 * failing the extension load and leaving omp's host bash in place.
 */
async function loadBashApproval(): Promise<{ approve: BashApproval; approvalDetails: BashApprovalDetails; settings: OmpSettings }> {
	let modules: [typeof import("@oh-my-pi/pi-coding-agent/tools/bash"), typeof import("@oh-my-pi/pi-coding-agent/config/settings")];
	try {
		modules = await Promise.all([import("@oh-my-pi/pi-coding-agent/tools/bash"), import("@oh-my-pi/pi-coding-agent/config/settings")]);
	} catch (error) {
		throw new Error(`cannot load omp's bash approval rules: ${errorMessage(error)}`);
	}
	const [{ BashTool }, { Settings }] = modules;
	if (typeof BashTool !== "function" || typeof Settings !== "function") throw new Error("cannot load omp's bash approval rules: BashTool or Settings missing");
	const bySettings = new WeakMap<object, InstanceType<typeof BashTool>>();
	const toolFor = (settings: OmpSettings) => {
		let tool = bySettings.get(settings);
		if (tool === undefined) {
			tool = new BashTool({ settings });
			bySettings.set(settings, tool);
		}
		return tool;
	};
	if (typeof toolFor(Settings.instance).formatApprovalDetails !== "function") throw new Error("cannot load omp's bash approval rules: formatApprovalDetails missing");
	return {
		approve: (args, ctx) => toolFor(ctx?.settings ?? Settings.instance).approval(args, ctx),
		approvalDetails: args => toolFor(Settings.instance).formatApprovalDetails(args),
		settings: Settings.instance,
	};
}
