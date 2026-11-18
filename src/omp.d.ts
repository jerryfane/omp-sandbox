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

	/** The part of omp's ToolSession a file tool's target parser reads. */
	export interface FileToolSession {
		cwd: string;
		settings: OmpSettings;
	}

	/** A tool's `approvalCacheTargets`: absolute paths, `tree\0<dir>/` for a recursive search, or URLs. */
	export type TargetParser = (args: unknown) => readonly string[] | undefined;

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
		parameters: ZodSchema;
		/** Extension tools default to "discoverable"; "essential" keeps a tool top-level. */
		loadMode?: "essential" | "discoverable";
		/** Approval tier or per-call decision; defaults to "exec". */
		approval?: ToolApprovalDecision | ((args: unknown, ctx?: ApprovalContext) => ToolApprovalDecision);
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
	}
}

declare module "@oh-my-pi/pi-coding-agent/tools/bash" {
	import type { ApprovalContext, OmpSettings, ToolApprovalDecision } from "@oh-my-pi/pi-coding-agent";

	/** omp's built-in bash; constructed here only for its approval rules, which read nothing but settings. */
	export class BashTool {
		constructor(session: { settings: OmpSettings });
		readonly approval: (args: unknown, ctx?: ApprovalContext) => ToolApprovalDecision;
	}
}

declare module "@oh-my-pi/pi-coding-agent/config/settings" {
	import type { OmpSettings } from "@oh-my-pi/pi-coding-agent";

	export class Settings {
		/** The process settings (omp's main session uses this object). */
		static get instance(): OmpSettings;
	}
}

// omp's file tools, constructed here only for `approvalCacheTargets`, which reads the session's cwd and settings.
declare module "@oh-my-pi/pi-coding-agent/tools/read" {
	import type { FileToolSession, TargetParser } from "@oh-my-pi/pi-coding-agent";
	export class ReadTool {
		constructor(session: FileToolSession);
		readonly approvalCacheTargets: TargetParser;
	}
}
declare module "@oh-my-pi/pi-coding-agent/tools/write" {
	import type { FileToolSession, TargetParser } from "@oh-my-pi/pi-coding-agent";
	export class WriteTool {
		constructor(session: FileToolSession);
		readonly approvalCacheTargets: TargetParser;
	}
}
declare module "@oh-my-pi/pi-coding-agent/edit" {
	import type { FileToolSession, TargetParser } from "@oh-my-pi/pi-coding-agent";
	export class EditTool {
		constructor(session: FileToolSession);
		readonly approvalCacheTargets: TargetParser;
	}
}
declare module "@oh-my-pi/pi-coding-agent/tools/grep" {
	import type { FileToolSession, TargetParser } from "@oh-my-pi/pi-coding-agent";
	export class GrepTool {
		constructor(session: FileToolSession);
		readonly approvalCacheTargets: TargetParser;
	}
}
declare module "@oh-my-pi/pi-coding-agent/tools/glob" {
	import type { FileToolSession, TargetParser } from "@oh-my-pi/pi-coding-agent";
	export class GlobTool {
		constructor(session: FileToolSession);
		readonly approvalCacheTargets: TargetParser;
	}
}
declare module "@oh-my-pi/pi-coding-agent/tools/jfind/index" {
	import type { FileToolSession, TargetParser } from "@oh-my-pi/pi-coding-agent";
	export class FindTool {
		constructor(session: FileToolSession);
		readonly approvalCacheTargets: TargetParser;
	}
}
declare module "@oh-my-pi/pi-coding-agent/tools/ast-grep" {
	import type { FileToolSession, TargetParser } from "@oh-my-pi/pi-coding-agent";
	export class AstGrepTool {
		constructor(session: FileToolSession);
		readonly approvalCacheTargets: TargetParser;
	}
}

declare module "@oh-my-pi/pi-ai" {
	/** The canonical assistant event stream a command-backed provider returns (used by test fixtures). */
	export class AssistantMessageEventStream {
		push(event: Record<string, unknown>): void;
		end(result?: Record<string, unknown>): void;
	}
}
