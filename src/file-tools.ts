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
import * as os from "node:os";
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
 *
 * Two checks. The tool's own approval targets, its reading of the arguments.
 * And a lexical one over the raw path arguments, because `read` takes a path
 * list that it splits only at execution (`;`, `,`, whitespace, after decoding
 * a file:// URL, around internal URLs), which its approval target does not
 * show. The lexical check splits more than any tool does and needs no
 * filesystem state, so it gives the same answer whenever it runs: a path that
 * holds a delimiter followed by an outside path is refused even when it names
 * a real file inside the copy.
 */
export function refuseFileCall(tool: NativeFileTool, toolName: string, args: unknown, root: string): string | undefined {
	const targets = (tool.approvalCacheTargets(args) ?? []).map(target => (target.startsWith(TREE_PREFIX) ? target.slice(TREE_PREFIX.length) : target));
	for (const file of targets) {
		if (!path.isAbsolute(file)) {
			if (file.includes("://")) continue; // an internal or web URL, not a file here
			return `omp-sandbox: cannot tell where ${JSON.stringify(file)} is; refusing ${toolName}`;
		}
		const refused = refusePath(file, root);
		if (refused !== undefined) return refused;
	}
	const tokens = rawPathTokens(args);
	if (tokens === undefined) return `omp-sandbox: ${toolName}'s path arguments expand to too many paths to check; refusing it`;
	for (const token of tokens) {
		if (token.startsWith("~") && token !== "~" && !token.startsWith("~/")) return `omp-sandbox: cannot tell where ${JSON.stringify(token)} is; refusing ${toolName}`;
		const file = token === "~" || token.startsWith("~/") ? path.join(os.homedir(), token.slice(1)) : path.resolve(root, token);
		const refused = refusePath(file, root);
		if (refused !== undefined) return refused;
	}
	return undefined;
}

function refusePath(file: string, root: string): string | undefined {
	if (!isInside(root, file)) {
		return `omp-sandbox: ${file} is outside the sandboxed workspace ${root}; only paths inside it exist in the sandbox`;
	}
	if (path.relative(root, path.resolve(file)).split(path.sep).some(part => part.toLowerCase() === ".git")) {
		return `omp-sandbox: ${file} is inside a .git directory, which is not copied from the sandbox; use git through bash instead`;
	}
	return undefined;
}

/** Characters any omp file tool may treat as a path-list separator; braces left after expansion are unbalanced and split too. */
const TOKEN_SPLIT = /[;,\s\u200b{}]+/u;

/** How many paths one argument may expand to (brace alternatives multiply) before the call is refused. */
const MAX_EXPANSIONS = 1024;

/**
 * Every path-like token in the raw `path` and `paths` arguments: brace
 * alternatives expanded with their prefix and suffix (`{src,test}/x` is
 * `src/x` and `test/x`), then split on every separator, also after
 * percent-decoding and removing `file://` prefixes. Prefixes omp strips (`@`,
 * a stray `:`, quotes) are removed. URLs other than file:// and `!glob`
 * exclusions are left out. Undefined when an argument expands past
 * MAX_EXPANSIONS.
 */
function rawPathTokens(args: unknown): string[] | undefined {
	if (args === null || typeof args !== "object") return [];
	const fields = args as { path?: unknown; paths?: unknown };
	const values = [fields.path, ...(Array.isArray(fields.paths) ? fields.paths : [fields.paths])].filter((value): value is string => typeof value === "string" && value !== "");
	const tokens = new Set<string>();
	for (const value of values) {
		const variants = new Set([value, decodeLoosely(value)]);
		for (const variant of [...variants]) variants.add(variant.replace(/file:\/\/(localhost)?/gi, ""));
		for (const variant of variants) {
			const expanded = expandBraces(variant);
			if (expanded === undefined) return undefined;
			for (const piece of expanded.flatMap(text => text.split(TOKEN_SPLIT))) {
				const token = piece.replace(/^["'`]+|["'`]+$/g, "").replace(/^@/, "").replace(/^:(?=[/\\~.])/, "");
				if (token === "" || token.startsWith("!") || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue;
				tokens.add(token);
			}
		}
	}
	return [...tokens];
}

/**
 * `text` with every balanced brace group expanded to its comma-separated
 * alternatives, each with the group's prefix and suffix; a group with no
 * comma is its one alternative. An unbalanced brace is left as it is (then
 * split as a separator). Undefined past MAX_EXPANSIONS results.
 */
function expandBraces(text: string): string[] | undefined {
	const out: string[] = [];
	const pending = [text];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		const group = firstBraceGroup(current);
		if (group === undefined) {
			out.push(current);
			if (out.length > MAX_EXPANSIONS) return undefined;
			continue;
		}
		const prefix = current.slice(0, group.open);
		const suffix = current.slice(group.close + 1);
		for (const alternative of group.alternatives) pending.push(prefix + alternative + suffix);
		if (out.length + pending.length > MAX_EXPANSIONS) return undefined;
	}
	return out;
}

/** The first `{` that has a matching `}`, and its top-level comma-separated alternatives. */
function firstBraceGroup(text: string): { open: number; close: number; alternatives: string[] } | undefined {
	for (let open = text.indexOf("{"); open !== -1; open = text.indexOf("{", open + 1)) {
		let depth = 0;
		let start = open + 1;
		const alternatives: string[] = [];
		for (let i = open; i < text.length; i++) {
			const ch = text[i];
			if (ch === "\\") {
				i++;
			} else if (ch === "{") {
				depth++;
			} else if (ch === "}") {
				depth--;
				if (depth === 0) {
					alternatives.push(text.slice(start, i));
					return { open, close: i, alternatives };
				}
			} else if (ch === "," && depth === 1) {
				alternatives.push(text.slice(start, i));
				start = i + 1;
			}
		}
	}
	return undefined;
}

/** Percent-decoding that never throws: a malformed escape is kept as it is. */
function decodeLoosely(text: string): string {
	return text.replace(/(%[0-9a-f]{2})+/gi, run => {
		try {
			return decodeURIComponent(run);
		} catch {
			return run;
		}
	});
}

function isInside(root: string, file: string): boolean {
	const relative = path.relative(root, path.resolve(file));
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
