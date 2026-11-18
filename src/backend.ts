/**
 * A Backend is "where commands run": a sandbox with its own processes and
 * files. The omp tool replacements (bash, read, write, edit, grep, glob) talk
 * only to this interface, so the same tools work against the local test
 * stand-in, a gitmoot workspace, or later ssh/docker.
 *
 * Every path a Backend method takes is a sandbox path: an absolute POSIX path
 * inside the sandbox's own filesystem. Translating the seat's host paths to
 * sandbox paths is the tool layer's job, not the backend's.
 */

export type OutputStream = "stdout" | "stderr";

export interface ExecOptions {
	/** Absolute sandbox path the command runs in. */
	cwd: string;
	/**
	 * Extra environment variables. A backend starts from its own minimal
	 * environment, never the host's, so host secrets cannot leak in.
	 */
	env?: Record<string, string>;
	/** Kill the command (and everything it started) after this many ms. */
	timeoutMs?: number;
	/** Aborting kills the command (and everything it started). */
	signal?: AbortSignal;
	/** Receives output as it arrives, in arrival order. */
	onOutput?: (chunk: string, stream: OutputStream) => void;
	/**
	 * Stop capturing after this many bytes per stream; the command keeps
	 * running and `truncated` is set. Default: DEFAULT_MAX_OUTPUT_BYTES.
	 */
	maxOutputBytes?: number;
}

export interface ExecResult {
	/** Process exit code, or null when it was killed by a signal. */
	exitCode: number | null;
	/** Signal that ended the process, if any. */
	signal: string | null;
	stdout: string;
	stderr: string;
	/** True when either stream was cut at maxOutputBytes. */
	truncated: boolean;
	/** True when the command was killed because timeoutMs elapsed. */
	timedOut: boolean;
	/** True when the command was killed because the signal aborted. */
	aborted: boolean;
}

export type FileType = "file" | "dir" | "symlink" | "other";

export interface FileStat {
	/** Absolute sandbox path. */
	path: string;
	type: FileType;
	size: number;
	mtimeMs: number;
}

export interface ListOptions {
	/** Walk subdirectories too. Default false. */
	recursive?: boolean;
	/** Stop after this many entries; the result says whether it stopped. */
	limit?: number;
}

export interface ListResult {
	entries: FileStat[];
	/** True when `limit` cut the listing short. */
	truncated: boolean;
}

export interface Backend {
	/** Short name for logs and errors, e.g. "local" or "gitmoot". */
	readonly name: string;
	/** Absolute sandbox path of the workspace root. */
	readonly root: string;
	/** Run a shell command (`bash -c <command>`) in the sandbox. */
	exec(command: string, options: ExecOptions): Promise<ExecResult>;
	/** Read a whole file. Rejects with a BackendError("ENOENT") when missing. */
	readFile(path: string): Promise<Uint8Array>;
	/** Write a whole file, creating parent directories as needed. */
	writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
	/** Stat without following a final symlink; null when the path does not exist. */
	stat(path: string): Promise<FileStat | null>;
	/** List a directory, sorted by path. */
	list(path: string, options?: ListOptions): Promise<ListResult>;
	/** Release the sandbox connection. The sandbox itself is not destroyed. */
	close(): Promise<void>;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type BackendErrorCode = "ENOENT" | "EISDIR" | "ENOTDIR" | "OUTSIDE_ROOT" | "INVALID_PATH";

export class BackendError extends Error {
	readonly code: BackendErrorCode;
	readonly path: string;

	constructor(code: BackendErrorCode, path: string, message: string) {
		super(message);
		this.name = "BackendError";
		this.code = code;
		this.path = path;
	}
}
