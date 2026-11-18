/**
 * Which tool calls may run against the host copy of the workspace, and which
 * must be refused because they would act on this machine instead.
 *
 * omp's own file tools run unchanged on the copy (a Mirror kept in sync with
 * the sandbox). What they touch is read with omp's own target parsers (each
 * tool's `approvalCacheTargets`), so a path outside the copy is refused with
 * the same reading of the arguments the tool itself will use.
 */
import * as path from "node:path";
import type { OmpSettings, TargetParser } from "@oh-my-pi/pi-coding-agent";

/** Tools refused outright, with the reason the model is told. */
export const REFUSED_TOOLS: Readonly<Record<string, string>> = {
	eval: "runs Python/JavaScript kernels on this machine",
	debug: "runs a debugger and the debugged program on this machine",
	lsp: "runs language servers on this machine, which can execute project build scripts",
	task: "starts subagents whose tools are not confined to the sandbox",
	// omp 18.20's AstEditTool reports no approvalCacheTargets, so where it would write cannot be checked.
	ast_edit: "cannot be checked to stay inside the sandboxed workspace (omp reports no paths for it)",
};

type ParserFactory = (session: { cwd: string; settings: OmpSettings }) => { approvalCacheTargets: TargetParser };

/** omp's own target parser for each file tool, by tool name. */
export type TargetParsers = Readonly<Record<string, ParserFactory>>;

/**
 * Load omp's file tools for their target parsers. Dynamic so that a moved
 * module or a missing parser becomes a setup error (every call refused)
 * instead of a failed extension load, which would leave omp's host tools in
 * place. The specifiers are literal: omp's extension loader maps only those
 * to its bundled modules.
 */
export async function loadTargetParsers(cwd: string, settings: OmpSettings): Promise<TargetParsers> {
	let modules;
	try {
		modules = await Promise.all([
			import("@oh-my-pi/pi-coding-agent/tools/read"),
			import("@oh-my-pi/pi-coding-agent/tools/write"),
			import("@oh-my-pi/pi-coding-agent/edit"),
			import("@oh-my-pi/pi-coding-agent/tools/grep"),
			import("@oh-my-pi/pi-coding-agent/tools/glob"),
			import("@oh-my-pi/pi-coding-agent/tools/jfind/index"),
			import("@oh-my-pi/pi-coding-agent/tools/ast-grep"),
		]);
	} catch (error) {
		throw new Error(`cannot load omp's file tools: ${error instanceof Error ? error.message : String(error)}`);
	}
	const [{ ReadTool }, { WriteTool }, { EditTool }, { GrepTool }, { GlobTool }, { FindTool }, { AstGrepTool }] = modules;
	const parsers: TargetParsers = {
		read: session => new ReadTool(session),
		write: session => new WriteTool(session),
		edit: session => new EditTool(session),
		grep: session => new GrepTool(session),
		glob: session => new GlobTool(session),
		find: session => new FindTool(session),
		ast_grep: session => new AstGrepTool(session),
	};
	for (const [name, factory] of Object.entries(parsers)) {
		let parser: unknown;
		try {
			parser = factory({ cwd, settings }).approvalCacheTargets;
		} catch (error) {
			throw new Error(`cannot load omp's ${name} tool: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof parser !== "function") throw new Error(`omp's ${name} tool reports no paths (approvalCacheTargets); its calls cannot be checked`);
	}
	if (Object.keys(parsers).sort().join() !== Object.keys(FILE_TOOLS).sort().join()) throw new Error("omp-sandbox: file-tool parsers and FILE_TOOLS disagree");
	return parsers;
}

/** omp's file tools that run on the host copy (and are blocked when the sandbox is unusable). */
export const FILE_TOOLS: Readonly<Record<string, true>> = { read: true, write: true, edit: true, grep: true, glob: true, find: true, ast_grep: true };

/** Whether `toolName` is a file tool that runs on the host copy. */
export function isFileTool(toolName: string): boolean {
	return Object.hasOwn(FILE_TOOLS, toolName);
}

/** Why `toolName` is refused outright, or undefined when it is not. */
export function refusedToolReason(toolName: string): string | undefined {
	return Object.hasOwn(REFUSED_TOOLS, toolName) ? REFUSED_TOOLS[toolName] : undefined;
}

/** A recursive search target, as omp keys one: NUL-prefixed "tree", then the folder with a trailing slash. */
const TREE_PREFIX = "tree\0";

/**
 * Why a file-tool call must not run against the copy at `root`, or undefined
 * when every path it touches is inside it. Internal and web URLs are not
 * workspace paths and are left to the tool.
 */
export function refuseFileCall(parsers: TargetParsers, toolName: string, args: unknown, root: string, cwd: string, settings: OmpSettings): string | undefined {
	const factory = Object.hasOwn(parsers, toolName) ? parsers[toolName] : undefined;
	if (factory === undefined) return `omp-sandbox: ${toolName} has no target parser; refusing it`;
	const targets = factory({ cwd, settings }).approvalCacheTargets(args) ?? [];
	for (const target of targets) {
		const file = target.startsWith(TREE_PREFIX) ? target.slice(TREE_PREFIX.length) : target;
		if (!path.isAbsolute(file)) {
			if (file.includes("://")) continue; // an internal or web URL, not a file here
			return `omp-sandbox: cannot tell where ${JSON.stringify(file)} is; refusing ${toolName}`;
		}
		if (!isInside(root, file)) {
			return `omp-sandbox: ${file} is outside the sandboxed workspace ${root}; only paths inside it exist in the sandbox`;
		}
	}
	return undefined;
}

function isInside(root: string, file: string): boolean {
	const relative = path.relative(root, path.resolve(file));
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
