/**
 * omp's file tools as the extension uses them: which tools run on the host
 * copy of the workspace, which are refused outright, and the native tool
 * instances the extension's shadows delegate to.
 *
 * A shadow takes everything the model and the approval gate see (schema,
 * description, approval tier, approval targets, prompt rows) from an instance
 * of omp's own tool class, so nothing is copied by hand. The same instance's
 * `approvalCacheTargets` decides whether a call stays inside the copy: the
 * reading of the arguments omp's approval gate uses.
 */
import * as path from "node:path";
import type { FileToolSession, NativeFileTool } from "@oh-my-pi/pi-coding-agent";

/**
 * The file tools that run on the host copy, one entry each: the only list.
 * Loaders are dynamic so that a moved module becomes a setup error (every
 * call refused) instead of a failed extension load, which would leave omp's
 * host tools in place. Their specifiers are literal: omp's extension loader
 * maps only those to its bundled modules.
 */
const FILE_TOOLS = {
	read: async () => (await import("@oh-my-pi/pi-coding-agent/tools/read")).ReadTool,
	write: async () => (await import("@oh-my-pi/pi-coding-agent/tools/write")).WriteTool,
	edit: async () => (await import("@oh-my-pi/pi-coding-agent/edit")).EditTool,
	grep: async () => (await import("@oh-my-pi/pi-coding-agent/tools/grep")).GrepTool,
	glob: async () => (await import("@oh-my-pi/pi-coding-agent/tools/glob")).GlobTool,
	find: async () => (await import("@oh-my-pi/pi-coding-agent/tools/jfind/index")).FindTool,
	ast_grep: async () => (await import("@oh-my-pi/pi-coding-agent/tools/ast-grep")).AstGrepTool,
} satisfies Record<string, () => Promise<new (session: FileToolSession) => NativeFileTool>>;

export type FileToolName = keyof typeof FILE_TOOLS;

/** Tools refused outright, with the reason the model is told. */
const REFUSED_TOOLS: Readonly<Record<string, string>> = {
	eval: "runs Python/JavaScript kernels on this machine",
	debug: "runs a debugger and the debugged program on this machine",
	lsp: "runs language servers on this machine, which can execute project build scripts",
	task: "starts subagents whose tools are not confined to the sandbox",
	// omp 18.20's AstEditTool reports no approvalCacheTargets, so where it would write cannot be checked.
	ast_edit: "cannot be checked to stay inside the sandboxed workspace (omp reports no paths for it)",
};

/** Whether `toolName` is a file tool that runs on the host copy. */
export function isFileTool(toolName: string): toolName is FileToolName {
	return Object.hasOwn(FILE_TOOLS, toolName);
}

/** Why `toolName` is refused outright, or undefined when it is not. */
export function refusedToolReason(toolName: string): string | undefined {
	return Object.hasOwn(REFUSED_TOOLS, toolName) ? REFUSED_TOOLS[toolName] : undefined;
}

/** One of omp's file tools, and whether omp's settings offer it (e.g. `find.enabled`). */
export interface LoadedFileTool {
	native: NativeFileTool;
	allowed: boolean;
}

/**
 * An instance of each of omp's file tools, bound to `session`, with whether
 * omp's own tool plan (`resolveBuiltinToolPlan`) offers it under the
 * session's settings. Throws when a module is missing or a tool lacks what a
 * shadow needs (a schema, a description, an approval-target parser).
 */
export async function loadFileTools(session: FileToolSession): Promise<ReadonlyMap<FileToolName, LoadedFileTool>> {
	let plan: { isAllowed(name: string): boolean };
	try {
		plan = await (await import("@oh-my-pi/pi-coding-agent/tools/index")).resolveBuiltinToolPlan(session);
	} catch (error) {
		throw new Error(`cannot read omp's tool plan: ${error instanceof Error ? error.message : String(error)}`);
	}
	const tools = new Map<FileToolName, LoadedFileTool>();
	for (const [name, load] of Object.entries(FILE_TOOLS) as [FileToolName, (typeof FILE_TOOLS)[FileToolName]][]) {
		let native: NativeFileTool;
		try {
			native = new (await load())(session);
			if (native.parameters === undefined || typeof native.description !== "string") throw new Error("no schema or description");
		} catch (error) {
			throw new Error(`cannot load omp's ${name} tool: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof native.approvalCacheTargets !== "function") {
			throw new Error(`omp's ${name} tool reports no paths (approvalCacheTargets); its calls cannot be checked`);
		}
		tools.set(name, { native, allowed: plan.isAllowed(name) });
	}
	return tools;
}

/** A recursive search target, as omp keys one: NUL-prefixed "tree", then the folder with a trailing slash. */
const TREE_PREFIX = "tree\0";

/**
 * Why a file-tool call must not run against the copy at `root`, or undefined
 * when every path it touches is inside it. Internal and web URLs are not
 * workspace paths and are left to the tool.
 */
export function refuseFileCall(tool: NativeFileTool, toolName: string, args: unknown, root: string): string | undefined {
	for (const target of tool.approvalCacheTargets(args) ?? []) {
		const file = target.startsWith(TREE_PREFIX) ? target.slice(TREE_PREFIX.length) : target;
		if (!path.isAbsolute(file)) {
			if (file.includes("://")) continue; // an internal or web URL, not a file here
			return `omp-sandbox: cannot tell where ${JSON.stringify(file)} is; refusing ${toolName}`;
		}
		if (!isInside(root, file)) {
			return `omp-sandbox: ${file} is outside the sandboxed workspace ${root}; only paths inside it exist in the sandbox`;
		}
		if (path.relative(root, path.resolve(file)).split(path.sep).some(part => part.toLowerCase() === ".git")) {
			return `omp-sandbox: ${file} is inside a .git directory, which is not copied from the sandbox; use git through bash instead`;
		}
	}
	return undefined;
}

function isInside(root: string, file: string): boolean {
	const relative = path.relative(root, path.resolve(file));
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
