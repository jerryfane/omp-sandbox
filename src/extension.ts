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
 * Fail closed: when configured but the backend cannot be set up, `bash`
 * refuses every call instead of running on the host.
 *
 * Step 2a scope: only `bash` moves. read/edit/write/grep/glob/find still act
 * on host files until step 2b; do not use this for a live agent yet.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Backend } from "./backend.ts";
import { LocalBackend } from "./local-backend.ts";
import { PathMap } from "./path-map.ts";

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

	const z = pi.zod;
	pi.registerTool<BashParams>({
		name: "bash",
		label: "Bash (sandbox)",
		description: TOOL_DESCRIPTION,
		// The built-in bash's parameters (omp 18.20). Mirrored by hand because
		// an extension cannot read the native schema at load time; a test
		// compares these names with the installed omp's.
		parameters: z.object({
			command: z.string(),
			timeout: z.number().optional(),
			cwd: z.string().optional(),
			pty: z.boolean().optional(),
			async: z.boolean().optional(),
			name: z.string().optional(),
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
		approval: "exec",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (setup === undefined) {
				throw new Error(`omp-sandbox: the ${kind} sandbox is not available (${setupError}); refusing to run on this machine`);
			}
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
	const hostRoot = process.env.OMP_SANDBOX_HOST_ROOT || process.cwd();
	if (kind === "local") {
		const root = process.env.OMP_SANDBOX_LOCAL_ROOT;
		if (root === undefined || root === "") throw new Error("OMP_SANDBOX_LOCAL_ROOT is not set");
		const containment = process.env.OMP_SANDBOX_LOCAL_CONTAINMENT;
		if (containment !== undefined && containment !== "" && containment !== "full" && containment !== "process-tree") {
			throw new Error(`OMP_SANDBOX_LOCAL_CONTAINMENT must be "full" or "process-tree", not ${containment}`);
		}
		const backend = await LocalBackend.create(root, containment ? { containment } : {});
		return { backend, paths: new PathMap(hostRoot, backend.root) };
	}
	throw new Error(`unknown OMP_SANDBOX_BACKEND ${kind}`);
}
