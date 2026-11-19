/**
 * Type declarations for the part of omp this add-on uses, mirrored from
 * @oh-my-pi/pi-coding-agent and @oh-my-pi/pi-agent-core 18.20.0
 * (extensibility/extensions/types.d.ts, types.d.ts, tools/bash.d.ts,
 * config/settings.d.ts).
 *
 * The real modules are provided by the omp binary at runtime. Installing the
 * packages only for their types would pull in about 60 MB of dependencies.
 * The integration test runs the add-on inside the installed omp; that is what
 * catches a drift between these declarations and omp.
 */
declare module "@oh-my-pi/pi-coding-agent" {
	/** The subset of omp's bundled zod used to declare tool parameters. */
	export interface ZodSchema {
		optional(): ZodSchema;
		max(length: number): ZodSchema;
	}

	export interface Zod {
		object(shape: Record<string, ZodSchema>): ZodSchema;
		string(): ZodSchema;
		number(): ZodSchema;
		boolean(): ZodSchema;
	}

	export interface ToolResultContent {
		type: string;
		text?: string;
	}

	export interface AgentToolResult {
		content: ToolResultContent[];
		details?: unknown;
		isError?: boolean;
	}

	export type AgentToolUpdateCallback = (partialResult: AgentToolResult) => void;

	export interface ExtensionContext {
		/** The session's working directory (a host path). */
		cwd: string;
		/**
		 * Runs the native built-in of the same name as the calling tool, when
		 * the calling tool shadows one.
		 */
		invokeTool?(
			params: Record<string, unknown>,
			options?: { signal?: AbortSignal | undefined; onUpdate?: AgentToolUpdateCallback | undefined },
		): Promise<AgentToolResult>;
	}

	/** omp's session settings (opaque here; only passed back to omp). */
	export type OmpSettings = object;

	/** The part of omp's ToolSession a file tool reads for its schema, description and approval. */
	export interface FileToolSession {
		cwd: string;
		settings: OmpSettings;
		/** The session's current model; edit picks its mode and description from it. */
		getActiveModel?: () => OmpModel | undefined;
		/** `provider/id` of the current model, as omp formats it. */
		getActiveModelString?: () => string | undefined;
	}

	/** A model, as omp passes it to extensions (the fields used here). */
	export interface OmpModel {
		provider: string;
		id: string;
	}

	/** The context omp passes to session event handlers (the field used here). */
	export interface SessionEventContext {
		model?: OmpModel;
	}

	/** A tool's `approvalCacheTargets`: absolute paths, `tree\0<dir>/` for a recursive search, or URLs. */
	export type TargetParser = (args: unknown) => readonly string[] | undefined;

	/** The members of one of omp's file tools that a shadow forwards. */
	export interface NativeFileTool {
		readonly label: string;
		readonly description: string;
		/** The tool's schema (an ArkType type); handed back to omp unchanged. */
		readonly parameters: unknown;
		readonly loadMode?: "essential" | "discoverable";
		readonly strict?: boolean;
		readonly approval?: ToolApprovalDecision | ((args: unknown, ctx?: ApprovalContext) => ToolApprovalDecision);
		readonly approvalCacheTargets: TargetParser;
		readonly formatApprovalDetails?: (args: unknown) => string[];
	}

	/** What omp passes a tool's approval function (AgentToolContext, the fields used here). */
	export interface ApprovalContext {
		settings?: OmpSettings;
		toolNames?: string[];
	}

	export type ToolTier = "read" | "write" | "exec";

	export type ToolApprovalDecision =
		| ToolTier
		| { tier: ToolTier; override?: boolean; policy?: "allow" | "deny" | "prompt"; reason?: string; policyKey?: string };

	export interface ToolDefinition<TParams> {
		name: string;
		label: string;
		description: string;
		/** A zod schema (`pi.zod`), or a native tool's own ArkType schema passed through. */
		parameters: ZodSchema | unknown;
		/** Extension tools default to "discoverable"; "essential" keeps a tool top-level. */
		loadMode?: "essential" | "discoverable";
		/** "exclusive": omp runs the call alone, after every earlier call in the batch finished. */
		concurrency?: "shared" | "exclusive";
		/** Registered but not offered until activated (setActiveTools). */
		defaultInactive?: boolean;
		/** Approval tier or per-call decision; defaults to "exec". */
		approval?: ToolApprovalDecision | ((args: unknown, ctx?: ApprovalContext) => ToolApprovalDecision);
		/** Rows an approval prompt shows under "Allow tool: <name>". */
		formatApprovalDetails?: (args: unknown) => string[];
		execute(
			toolCallId: string,
			params: TParams,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult>;
	}

	/** Fired for each tool call before it runs (for a batch: every call, before any runs). */
	export interface ToolCallEvent {
		type: "tool_call";
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
	}

	export interface ToolCallEventResult {
		/** Refuse the call; `reason` is returned to the model as the error. */
		block?: boolean;
		reason?: string;
	}

	/** Fired after a tool ran, before the next tool of the turn starts. */
	export interface ToolResultEvent {
		type: "tool_result";
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
		content: ToolResultContent[];
		isError: boolean;
	}

	export interface ToolResultEventResult {
		content?: ToolResultContent[];
		isError?: boolean;
	}

	export interface ExtensionAPI {
		readonly zod: Zod;
		registerTool<TParams>(tool: ToolDefinition<TParams>): void;
		on(event: "tool_call", handler: (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined>): void;
		on(event: "tool_result", handler: (event: ToolResultEvent) => Promise<ToolResultEventResult | undefined>): void;
		/** Session start, each prompt and each turn: the context carries the current model. */
		on(event: "session_start" | "before_agent_start" | "turn_start", handler: (event: unknown, ctx: SessionEventContext) => Promise<void>): void;
	}
}

declare module "@oh-my-pi/pi-coding-agent/tools/bash" {
	import type { ApprovalContext, OmpSettings, ToolApprovalDecision } from "@oh-my-pi/pi-coding-agent";

	/** omp's built-in bash; constructed here only for its approval rules, which read nothing but settings. */
	export class BashTool {
		constructor(session: { settings: OmpSettings });
		readonly approval: (args: unknown, ctx?: ApprovalContext) => ToolApprovalDecision;
		/** The approval prompt's rows for `args`, e.g. `Command: …`. */
		readonly formatApprovalDetails: (args: unknown) => string[];
	}
}

declare module "@oh-my-pi/pi-coding-agent/config/settings" {
	import type { OmpSettings } from "@oh-my-pi/pi-coding-agent";

	export class Settings {
		/** The process settings (omp's main session uses this object). */
		static get instance(): OmpSettings;
	}
}

// omp's file tools; see NativeFileTool for the members used.
declare module "@oh-my-pi/pi-coding-agent/tools/read" {
	import type { FileToolSession, NativeFileTool } from "@oh-my-pi/pi-coding-agent";
	export const ReadTool: new (session: FileToolSession) => NativeFileTool;
}
declare module "@oh-my-pi/pi-coding-agent/tools/write" {
	import type { FileToolSession, NativeFileTool } from "@oh-my-pi/pi-coding-agent";
	export const WriteTool: new (session: FileToolSession) => NativeFileTool;
}
declare module "@oh-my-pi/pi-coding-agent/edit" {
	import type { FileToolSession, NativeFileTool } from "@oh-my-pi/pi-coding-agent";
	export const EditTool: new (session: FileToolSession) => NativeFileTool;
}
declare module "@oh-my-pi/pi-coding-agent/tools/grep" {
	import type { FileToolSession, NativeFileTool } from "@oh-my-pi/pi-coding-agent";
	export const GrepTool: new (session: FileToolSession) => NativeFileTool;
}
declare module "@oh-my-pi/pi-coding-agent/tools/glob" {
	import type { FileToolSession, NativeFileTool } from "@oh-my-pi/pi-coding-agent";
	export const GlobTool: new (session: FileToolSession) => NativeFileTool;
}
declare module "@oh-my-pi/pi-coding-agent/tools/jfind/index" {
	import type { FileToolSession, NativeFileTool } from "@oh-my-pi/pi-coding-agent";
	export const FindTool: new (session: FileToolSession) => NativeFileTool;
}
declare module "@oh-my-pi/pi-coding-agent/tools/ast-grep" {
	import type { FileToolSession, NativeFileTool } from "@oh-my-pi/pi-coding-agent";
	export const AstGrepTool: new (session: FileToolSession) => NativeFileTool;
}
// How omp's read splits a path list (`a;b`, `a,b`, quoted), at execution.
declare module "@oh-my-pi/pi-coding-agent/tools/path-utils" {
	export function splitDelimitedPathEntry(entry: string, cwd: string): Promise<string[] | null>;
}

declare module "@oh-my-pi/pi-coding-agent/tools/index" {
	import type { FileToolSession } from "@oh-my-pi/pi-coding-agent";
	/** Which built-in tools a session gets under its settings. */
	export function resolveBuiltinToolPlan(session: FileToolSession): Promise<{ isAllowed(name: string): boolean }>;
}

declare module "@oh-my-pi/pi-ai" {
	/** The canonical assistant event stream a command-backed provider returns (used by test fixtures). */
	export class AssistantMessageEventStream {
		push(event: Record<string, unknown>): void;
		end(result?: Record<string, unknown>): void;
	}
}
