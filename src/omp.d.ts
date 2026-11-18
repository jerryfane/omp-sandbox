/**
 * Type declarations for the part of omp's extension API this add-on uses,
 * mirrored from @oh-my-pi/pi-coding-agent and @oh-my-pi/pi-agent-core 18.20.0
 * (extensibility/extensions/types.d.ts, types.d.ts).
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

	export interface ToolDefinition<TParams> {
		name: string;
		label: string;
		description: string;
		parameters: ZodSchema;
		/** Extension tools default to "discoverable"; "essential" keeps a tool top-level. */
		loadMode?: "essential" | "discoverable";
		/** Approval tier; defaults to "exec". */
		approval?: "read" | "write" | "exec";
		execute(
			toolCallId: string,
			params: TParams,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult>;
	}

	export interface ExtensionAPI {
		readonly zod: Zod;
		registerTool<TParams>(tool: ToolDefinition<TParams>): void;
	}
}

declare module "@oh-my-pi/pi-ai" {
	/** The canonical assistant event stream a command-backed provider returns (used by test fixtures). */
	export class AssistantMessageEventStream {
		push(event: Record<string, unknown>): void;
		end(result?: Record<string, unknown>): void;
	}
}
