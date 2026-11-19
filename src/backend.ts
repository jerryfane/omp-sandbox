/**
 * A Backend is "where commands run": a sandbox with its own processes and
 * files. The omp tool replacements (bash, read, write, edit, grep, glob) talk
 * only to this interface, so the same tools work against the local test
 * stand-in, a gitmoot workspace, or later ssh/docker.
 *
 * Every path a Backend method takes is a sandbox path: an absolute POSIX path
 * inside the sandbox's own filesystem. Translating the seat's host paths to
 * sandbox paths is the tool layer's job, not the backend's. No method may
 * ever read, write, list or stat anything outside the sandbox, whatever
 * symlinks or concurrent renames the sandbox contains.
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
	/**
	 * Kill the command after this many ms. How far the kill reaches (the whole
	 * tree, or only the command's process group) is Backend.containment.
	 */
	timeoutMs?: number;
	/** Aborting kills the command the same way a timeout does. */
	signal?: AbortSignal;
	/** Receives output as it arrives, in arrival order. */
	onOutput?: (chunk: string, stream: OutputStream) => void;
	/**
	 * Stop capturing after this many bytes per stream; the command keeps
	 * running and `truncated` is set. Default: DEFAULT_MAX_OUTPUT_BYTES.
	 */
	maxOutputBytes?: number;
}

export interface ShellCommandOptions {
	/** Absolute sandbox path the command runs in. */
	cwd: string;
	/** Extra environment variables, as for ExecOptions.env. */
	env?: Record<string, string>;
}

export interface ExecResult {
	/** The command's exit code, or null when it was ended by a signal. */
	exitCode: number | null;
	/**
	 * The signal that ended the command, if any: one it raised or received
	 * itself, or the backend's SIGKILL on timeout or abort.
	 */
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

/**
 * One entry of the workspace tree, as `changes` reports it. `path` is
 * relative to the root and `/`-separated; it never contains `.` or `..`
 * components.
 */
export interface TreeEntry {
	path: string;
	type: FileType;
	size: number;
	mtimeMs: number;
	/** Permission bits (`mode & 0o7777`). */
	mode: number;
}

export interface Changes {
	/** Pass to the next `changes` call. */
	token: string;
	/**
	 * True when `since` was absent or unknown to the backend: `changed` then
	 * lists the whole tree and `deleted` is empty, so the caller must treat
	 * anything it knows that is not listed as deleted.
	 */
	full: boolean;
	/**
	 * Entries created or modified since the token (or every entry when
	 * `full`). It may list unchanged entries too (a backend that cannot tell
	 * from metadata alone reports them), but must never leave out a changed
	 * one; the caller compares contents.
	 */
	changed: TreeEntry[];
	/** Paths that existed at the token and exist no more. */
	deleted: string[];
}

/** A regular file moved by `pull` or `push`; `path` as in TreeEntry. */
export interface SyncFile {
	path: string;
	/** Permission bits (`mode & 0o7777`). */
	mode: number;
	data: Uint8Array;
}

export interface Backend {
	/** Short name for logs and errors, e.g. "local" or "gitmoot". */
	readonly name: string;
	/** Absolute sandbox path of the workspace root. */
	readonly root: string;
	/**
	 * How exec contains what a command starts, strongest first. "full": every
	 * descendant is killed on timeout or abort, and processes still running
	 * when the command's shell exits are killed then. "process-tree": the kill
	 * reaches every descendant still linked to the command, but one whose
	 * parent has already exited, and anything left running after the shell
	 * exits, survives. "process-group": the kill reaches the command's process
	 * group only; a descendant that moved to another group or session
	 * (`setsid`) survives, and so does anything left running after the shell
	 * exits.
	 */
	readonly containment: "full" | "process-tree" | "process-group";
	/**
	 * Run a shell command (`bash -c <command>`) in the sandbox. stdout and
	 * stderr carry only the command's own output; the backend adds nothing.
	 */
	exec(command: string, options: ExecOptions): Promise<ExecResult>;
	/**
	 * A host shell command line that runs `command` (`bash -c`) in the sandbox,
	 * for a caller that runs processes itself: omp's own bash tool runs this
	 * line, so its background jobs, timeouts and output handling keep working.
	 *
	 * The line:
	 * - streams the command's stdout and stderr live and connects no stdin;
	 * - exits with the command's exit code, or 128+n when signal n ended it;
	 * - calls external programs by absolute path only, so a host shell with
	 *   in-process builtins (omp's embedded bash has its own `env`) cannot
	 *   run them inside its own process;
	 * - does not start with `cd` (omp rewrites a leading `cd x &&`).
	 *
	 * When the caller kills the process it started for the line, what the
	 * command started is ended as far as the backend's containment reaches;
	 * for a gitmoot workspace, through its exec watchdog.
	 *
	 * Synchronous and side-effect free: it only builds the string. It throws a
	 * BackendError for a cwd outside the root or an invalid environment name.
	 */
	shellCommand(command: string, options: ShellCommandOptions): string;
	/** Read a whole regular file. Rejects with BackendError("ENOENT") when missing. */
	readFile(path: string): Promise<Uint8Array>;
	/**
	 * Write a whole regular file, creating parent directories as needed. With
	 * `mode` the file gets that mode; without it an existing file keeps its
	 * mode and a new one gets the default.
	 */
	writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
	/** Stat without following a final symlink; null when the path does not exist. */
	stat(path: string): Promise<FileStat | null>;
	/**
	 * List a directory, sorted by full path in byte order (C collation), so a
	 * `limit` keeps the sorted prefix. Symlinked directories are listed, never
	 * entered.
	 */
	list(path: string, options?: ListOptions): Promise<ListResult>;
	/**
	 * What changed in the workspace tree since `since` (a token from an
	 * earlier call), or the whole tree when `since` is absent or unknown.
	 * `changed` may over-report but never under-report (see Changes).
	 * Symlinks are reported as entries, never followed. The `.git` directory
	 * is not part of the tree.
	 */
	changes(since?: string): Promise<Changes>;
	/**
	 * The contents of the regular files at `paths`. A path that is missing or
	 * not a regular file by the time it is read is left out; the next
	 * `changes` reports what it became.
	 */
	pull(paths: readonly string[]): Promise<SyncFile[]>;
	/**
	 * Write each file atomically (a reader sees the old or the new contents,
	 * never a mix), with its mode, creating parent directories as needed.
	 * Refuses (BackendError "SYMLINK") to replace a symlink and ("EISDIR") a
	 * directory.
	 */
	push(files: readonly SyncFile[]): Promise<void>;
	/**
	 * Remove each path: a file or symlink is unlinked, a directory removed
	 * only when empty. A path that no longer exists is not an error.
	 */
	remove(paths: readonly string[]): Promise<void>;
	/** Release the sandbox connection. The sandbox itself is not destroyed. */
	close(): Promise<void>;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type BackendErrorCode =
	| "ENOENT"
	| "EISDIR"
	| "ENOTDIR"
	/** The path is lexically outside the sandbox root. */
	| "OUTSIDE_ROOT"
	/** The path is not absolute or contains a NUL byte. */
	| "INVALID_PATH"
	/** The path goes through a symlink this backend will not follow. */
	| "SYMLINK"
	/** The path names a FIFO, socket or device, not a regular file. */
	| "NOT_REGULAR"
	/** The sandbox refused access (permissions). */
	| "EACCES"
	/** An environment variable name is not a valid shell name, or a value contains NUL. */
	| "INVALID_ENV";

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
