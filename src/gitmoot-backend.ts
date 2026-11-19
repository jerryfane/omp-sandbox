/**
 * The gitmoot backend: the sandbox is a gitmoot workspace, a remote VM that
 * `gitmoot workspace` manages (gitmoot/gitmoot#2678, WORKSPACES.md). This
 * module talks only to the gitmoot CLI, never to the VM directly; the CLI
 * holds the provider credentials and enforces the pilot's cost cap.
 *
 * Contract used: skills/gitmoot/references/WORKSPACES.md on gitmoot
 * feat/workspace-cli (6e51895a), pinned with the gitmoot seat (msgs 513679,
 * 513698, 513900):
 *   - `gitmoot workspace show <id> --json` prints
 *     {id, seat, repo, issue, pr, branch, base, root, provider, state, created_at, last_active_at, env};
 *     `root` is the absolute in-VM work tree, `state` is
 *     opening|ready|closing|closed|failed.
 *   - `gitmoot ws sh [--cwd REL] '<cmd>'` runs exactly one string as
 *     `bash -lc` in the workspace named by $GITMOOT_WORKSPACE, streams stdout
 *     and stderr apart, connects no stdin, and exits with the command's
 *     status, 128+n for signal n, or 124 on its own timeout. The VM gets only
 *     its base environment; nothing from the host.
 *   - SIGINT/SIGTERM to the CLI reaches the command's whole process group;
 *     if the CLI dies outright the VM-side watchdog kills the group within
 *     15 s. Only that group: a descendant that called `setsid` survives, so
 *     the containment here is "process-group".
 *   - When the CLI itself fails it exits 125 and prints
 *     {"error":{"code","message"}} on stderr.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { constants as osConstants } from "node:os";
import * as path from "node:path";
import {
	type Backend,
	BackendError,
	type Changes,
	DEFAULT_MAX_OUTPUT_BYTES,
	type ExecOptions,
	type ExecResult,
	type FileStat,
	type FileType,
	type ListOptions,
	type ListResult,
	type OutputStream,
	type SyncFile,
} from "./backend.ts";
import { readTar, writeTar } from "./tar.ts";
import { ENV_NAME, shellQuote } from "./shell.ts";

const SIGNAL_NAMES: ReadonlyMap<number, string> = new Map(Object.entries(osConstants.signals).map(([name, number]) => [number, name]));

/** What `--status-file` holds once the CLI is done (WORKSPACES.md, "exec and ws sh"). */
interface ExecStatus {
	exit_code: number | null;
	signal: number | null;
	timed_out: boolean;
	error: { code: string; message: string } | null;
}

/** What `gitmoot workspace show --json` reports (the fields used here). */
export interface WorkspaceInfo {
	id: string;
	root: string;
	state: string;
	provider: string;
}

/** The CLI itself failed: its documented error, with the command that failed. */
export class GitmootCliError extends Error {
	readonly code: string;

	constructor(command: string, code: string, message: string) {
		super(`gitmoot ${command}: ${code}: ${message}`);
		this.name = "GitmootCliError";
		this.code = code;
	}
}

/** Exit status the CLI uses for its own failures (docker-run convention). */
const CLI_FAILURE = 125;

export interface GitmootBackendOptions {
	/** Absolute path of the gitmoot binary. */
	bin: string;
	/** The workspace id (what $GITMOOT_WORKSPACE names). */
	workspace: string;
	/** A gitmoot home (`--home`); unset = the CLI's default home. */
	home?: string;
}

/** A workspace-relative path for pull, push and remove: not empty, no ".", ".." or empty components, no NUL. */
function checkRelative(rel: string): void {
	if (rel === "" || rel.includes("\0") || rel.split("/").some(part => part === "" || part === "." || part === "..")) {
		throw new BackendError("INVALID_PATH", rel, `workspace paths must be relative, without empty, . or .. components: ${rel}`);
	}
}

export class GitmootBackend implements Backend {
	readonly name = "gitmoot";
	readonly root: string;
	/** gitmoot's supervisor and watchdog kill the command's process group (within 15 s if the CLI dies), nothing outside it. */
	readonly containment = "process-group" as const;
	readonly bin: string;
	readonly workspace: string;
	readonly home: string | undefined;

	private constructor(options: GitmootBackendOptions, info: WorkspaceInfo) {
		this.bin = options.bin;
		this.home = options.home;
		this.workspace = info.id;
		this.root = info.root;
	}

	/** Connect to an existing workspace, which must be ready. */
	static async open(options: GitmootBackendOptions): Promise<GitmootBackend> {
		if (!path.isAbsolute(options.bin)) throw new Error(`the gitmoot binary must be an absolute path, not ${options.bin}`);
		if (options.home !== undefined && !path.isAbsolute(options.home)) throw new Error(`the gitmoot home must be an absolute path, not ${options.home}`);
		if (options.workspace === "" || /[\s\0]/.test(options.workspace)) throw new Error(`invalid gitmoot workspace id ${JSON.stringify(options.workspace)}`);
		const args = ["workspace", "show", options.workspace, ...homeArgs(options.home), "--json"];
		const info = parseWorkspace(await runCli(options.bin, args, "workspace show"));
		if (info.id !== options.workspace) throw new Error(`gitmoot workspace show returned workspace ${info.id}, not ${options.workspace}`);
		if (info.state !== "ready") throw new Error(`gitmoot workspace ${info.id} is ${info.state}, not ready`);
		return new GitmootBackend(options, info);
	}

	/**
	 * The host command line that runs `command` in the workspace: the CLI's
	 * `ws sh`, by absolute path, with the workspace id in its environment.
	 * Extra environment variables are exported inside the remote shell, since
	 * the VM never receives the host's environment.
	 */
	shellCommand(command: string, options: { cwd: string; env?: Record<string, string> }): string {
		const relative = this.#relative(options.cwd);
		let script = command;
		const exports: string[] = [];
		for (const [name, value] of Object.entries(options.env ?? {})) {
			if (!ENV_NAME.test(name) || value.includes("\0")) {
				throw new BackendError("INVALID_ENV", name, `invalid environment variable: ${name}`);
			}
			exports.push(`export ${name}=${shellQuote(value)}`);
		}
		if (exports.length > 0) script = `${exports.join("; ")}\n${command}`;
		return [
			"/usr/bin/env",
			shellQuote(`GITMOOT_WORKSPACE=${this.workspace}`),
			shellQuote(this.bin),
			"ws",
			"sh",
			...homeArgs(this.home).map(shellQuote),
			"--cwd",
			shellQuote(relative),
			shellQuote(script),
		].join(" ");
	}

	/**
	 * Run `command` (`bash -c`) in the workspace through `gitmoot workspace
	 * exec`, which streams stdout and stderr apart and writes a status file
	 * last. On timeout or abort the CLI gets SIGTERM, which it forwards to the
	 * command's whole process group (SIGKILL 3 s later); `signal` is then the
	 * one the command died of. A gitmoot failure (the status file's `error`)
	 * rejects with GitmootCliError instead of returning a result.
	 */
	async exec(command: string, options: ExecOptions): Promise<ExecResult> {
		const relative = this.#relative(options.cwd);
		const envArgs: string[] = [];
		for (const [name, value] of Object.entries(options.env ?? {})) {
			if (!ENV_NAME.test(name) || value.includes("\0")) {
				throw new BackendError("INVALID_ENV", name, `invalid environment variable: ${name}`);
			}
			envArgs.push("--env", `${name}=${value}`);
		}
		const result: ExecResult = { exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false, aborted: false };
		const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		// Cancellation is tracked from the start, so an abort or timeout during setup is never lost.
		let child: ReturnType<typeof spawn> | undefined;
		const cancel = (why: "timedOut" | "aborted") => {
			result[why] = true;
			child?.kill("SIGTERM");
		};
		const onAbort = () => cancel("aborted");
		if (options.signal?.aborted) onAbort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => cancel("timedOut"), options.timeoutMs);
		let statusDir: string | undefined;
		try {
			if (result.aborted || result.timedOut) return result;
			statusDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-gitmoot-"));
			if (result.aborted || result.timedOut) return result;
			const statusFile = path.join(statusDir, "status.json");
			const args = ["workspace", "exec", this.workspace, ...homeArgs(this.home), "--cwd", relative, ...envArgs, "--status-file", statusFile, "--", "/bin/bash", "-c", command];
			const spawned = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
			child = spawned;
			const capture = (stream: OutputStream) => {
				const decoder = new TextDecoder();
				let bytes = 0;
				return (chunk: Buffer) => {
					if (bytes >= limit) {
						result.truncated = true;
						return;
					}
					const piece = bytes + chunk.length > limit ? chunk.subarray(0, limit - bytes) : chunk;
					if (piece !== chunk) result.truncated = true;
					bytes += piece.length;
					const text = decoder.decode(piece, { stream: true });
					if (text === "") return;
					result[stream] += text;
					options.onOutput?.(text, stream);
				};
			};
			spawned.stdout?.on("data", capture("stdout"));
			spawned.stderr?.on("data", capture("stderr"));
			const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
				spawned.once("error", reject);
				spawned.once("close", (code, signal) => resolve({ code, signal }));
			});
			const status = await readStatus(statusFile);
			if (status === undefined) {
				// Ended by our own SIGTERM before gitmoot wrote a status (it had not installed its
				// handler yet): the cancellation the caller asked for, not a gitmoot failure.
				if ((result.timedOut || result.aborted) && exit.signal !== null) {
					result.signal = exit.signal;
					return result;
				}
				throw new Error(`gitmoot workspace exec exited ${exit.code ?? exit.signal} without a status file: ${result.stderr.trim().slice(0, 300)}`);
			}
			if (status.error !== null) throw new GitmootCliError("workspace exec", status.error.code, status.error.message);
			if (status.signal !== null) result.signal = SIGNAL_NAMES.get(status.signal) ?? `SIG${status.signal}`;
			else result.exitCode = status.exit_code;
			return result;
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (statusDir !== undefined) await fs.rm(statusDir, { recursive: true, force: true });
		}
	}

	/** Read a whole regular file (`workspace read`). */
	async readFile(file: string): Promise<Uint8Array> {
		const rel = this.#rel(file);
		const result = await callCli(this.bin, ["workspace", "read", this.workspace, ...homeArgs(this.home), rel], "workspace read");
		if (result.code === 0) return result.stdout;
		throw this.#fileError(result, file, "workspace read");
	}

	/** Write a whole regular file atomically (`workspace write`); an existing file keeps its mode unless `mode` is given. */
	async writeFile(file: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void> {
		const rel = this.#rel(file);
		if (rel === "") throw new BackendError("EISDIR", file, `is a directory: ${file}`);
		const modeArgs = options?.mode === undefined ? [] : ["--mode", (options.mode & 0o7777).toString(8)];
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		const result = await callCli(this.bin, ["workspace", "write", this.workspace, ...homeArgs(this.home), ...modeArgs, rel], "workspace write", bytes);
		if (result.code !== 0) throw this.#fileError(result, file, "workspace write");
	}

	/** Stat without following a final symlink (`workspace stat`); null when missing. */
	async stat(file: string): Promise<FileStat | null> {
		const rel = this.#rel(file);
		const result = await callCli(this.bin, ["workspace", "stat", this.workspace, ...homeArgs(this.home), rel, "--json"], "workspace stat");
		if (result.code === 3) return null;
		if (result.code !== 0) throw this.#fileError(result, file, "workspace stat");
		const value = JSON.parse(new TextDecoder().decode(result.stdout)) as { type: FileType; size: number; mtime: number };
		return { path: path.posix.normalize(file), type: value.type, size: value.size, mtimeMs: value.mtime * 1000 };
	}

	/**
	 * List a directory with `find` in the workspace (gitmoot has no listing
	 * command): `--cwd` confines the directory, and find never follows a
	 * symlink. The whole requested tree is read, then sorted by path in byte
	 * order, so `limit` bounds the result, not the work.
	 */
	async list(dir: string, options: ListOptions = {}): Promise<ListResult> {
		const info = await this.stat(dir);
		if (info === null) throw new BackendError("ENOENT", dir, `no such directory: ${dir}`);
		if (info.type === "symlink") throw new BackendError("SYMLINK", dir, `is a symlink: ${dir}`);
		if (info.type !== "dir") throw new BackendError("ENOTDIR", dir, `not a directory: ${dir}`);
		const depth = options.recursive ? "" : " -maxdepth 1";
		const result = await this.exec(`find . -mindepth 1${depth} -printf '%y %s %T@ %P\\0'`, { cwd: dir });
		if (result.exitCode !== 0 || result.truncated) {
			throw new Error(`listing ${dir} in the workspace failed (${result.truncated ? "output too large" : (result.exitCode ?? result.signal)}): ${result.stderr.trim().slice(0, 300)}`);
		}
		const base = path.posix.normalize(dir);
		const entries: FileStat[] = [];
		for (const record of result.stdout.split("\0")) {
			if (record === "") continue;
			const match = /^(\S) (\d+) ([\d.]+) (.+)$/s.exec(record);
			if (match === null) throw new Error(`listing ${dir}: unexpected find output ${JSON.stringify(record.slice(0, 100))}`);
			const [, kind, size, mtime, rel] = match as unknown as [string, string, string, string, string];
			const type: FileType = kind === "f" ? "file" : kind === "d" ? "dir" : kind === "l" ? "symlink" : "other";
			entries.push({ path: path.posix.join(base, rel), type, size: Number(size), mtimeMs: Number(mtime) * 1000 });
		}
		entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
		const limit = options.limit ?? Number.POSITIVE_INFINITY;
		return entries.length > limit ? { entries: entries.slice(0, limit), truncated: true } : { entries, truncated: false };
	}

	/** `workspace changes --since`; `reset` maps to `full`. Over-reports, never under-reports (gitmoot's racy-clean rule). */
	async changes(since?: string): Promise<Changes> {
		const out = await runCli(this.bin, ["workspace", "changes", this.workspace, ...homeArgs(this.home), "--since", since ?? "start", "--json"], "workspace changes");
		const value = JSON.parse(out) as { reset: boolean; token: string; changed: { path: string; type: FileType; size: number; mtime: number; mode: number }[]; deleted: string[] };
		return {
			token: value.token,
			full: value.reset || since === undefined,
			changed: value.changed.map(entry => ({ path: entry.path, type: entry.type, size: entry.size, mtimeMs: entry.mtime * 1000, mode: entry.mode & 0o7777 })),
			deleted: value.deleted,
		};
	}

	/** The regular files at `paths` (`workspace pull`, a tar stream); missing, special or symlinked paths are left out. */
	async pull(paths: readonly string[]): Promise<SyncFile[]> {
		if (paths.length === 0) return [];
		for (const rel of paths) checkRelative(rel);
		const result = await callCli(this.bin, ["workspace", "pull", this.workspace, ...homeArgs(this.home), "--", ...paths], "workspace pull");
		if (result.code !== 0) throw this.#fileError(result, paths.join(", "), "workspace pull");
		const wanted = new Set(paths);
		return readTar(result.stdout).flatMap(entry => (entry.type === "file" && wanted.has(entry.path) ? [{ path: entry.path, mode: entry.mode, data: entry.data }] : []));
	}

	/**
	 * Write each file (`workspace push --files`, a tar stream): atomic per
	 * file, with its mode, parents created. gitmoot refuses to replace a
	 * symlink (SYMLINK here) or a directory (EISDIR), checking the whole stream
	 * before applying anything.
	 */
	async push(files: readonly SyncFile[]): Promise<void> {
		if (files.length === 0) return;
		for (const file of files) checkRelative(file.path);
		const stream = writeTar(files.map(file => ({ type: "file" as const, path: file.path, mode: file.mode, data: file.data })));
		const result = await callCli(this.bin, ["workspace", "push", this.workspace, ...homeArgs(this.home), "--files", "--json"], "workspace push --files", stream);
		if (result.code === 0) return;
		const error = cliError("workspace push --files", result.stderr);
		if (error instanceof GitmootCliError && error.code === "cwd_outside_root" && /symlink/.test(error.message)) throw new BackendError("SYMLINK", files[0]?.path ?? "", error.message);
		if (error instanceof GitmootCliError && error.code === "is_directory") throw new BackendError("EISDIR", files[0]?.path ?? "", error.message);
		throw error;
	}

	/**
	 * Remove each path (`workspace remove`): unlink a file or symlink (never
	 * followed), remove a directory only when empty, ignore a path already
	 * gone. gitmoot fails a non-empty directory with `not_empty`, but here it
	 * stays (the sandbox has new content there): the batch is then retried one
	 * path at a time, which is safe because removing is idempotent.
	 */
	async remove(paths: readonly string[]): Promise<void> {
		if (paths.length === 0) return;
		for (const rel of paths) checkRelative(rel);
		try {
			await this.#removeBatch(paths);
		} catch (error) {
			if (!(error instanceof GitmootCliError && error.code === "not_empty")) throw error;
			for (const rel of paths) {
				await this.#removeBatch([rel]).catch((single: unknown) => {
					if (!(single instanceof GitmootCliError && single.code === "not_empty")) throw single;
				});
			}
		}
	}

	async #removeBatch(paths: readonly string[]): Promise<void> {
		await runCli(this.bin, ["workspace", "remove", this.workspace, ...homeArgs(this.home), "--json", "--", ...paths], "workspace remove");
	}

	/** Nothing to release: each CLI call is its own connection. The workspace stays. */
	async close(): Promise<void> {}

	/** A sandbox path as gitmoot's `<rel>`: relative to root, "" for the root itself; refuses anything outside. */
	#rel(file: string): string {
		if (!path.posix.isAbsolute(file) || file.includes("\0")) throw new BackendError("INVALID_PATH", file, `sandbox paths must be absolute: ${file}`);
		const relative = path.posix.relative(this.root, path.posix.normalize(file));
		if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
			throw new BackendError("OUTSIDE_ROOT", file, `path is outside the sandbox root: ${file}`);
		}
		return relative;
	}

	/** gitmoot's file-command exits as BackendErrors: 3 not found, 4 a directory, cwd_outside_root a symlink or escape. */
	#fileError(result: { code: number | null; stderr: string }, file: string, label: string): Error {
		if (result.code === 3) return new BackendError("ENOENT", file, `no such file: ${file}`);
		if (result.code === 4) return new BackendError("EISDIR", file, `is a directory: ${file}`);
		const error = cliError(label, result.stderr);
		if (error instanceof GitmootCliError && error.code === "cwd_outside_root") return new BackendError("SYMLINK", file, error.message);
		return error;
	}

	/**
	 * `cwd` relative to the root, as `./<path>/.` ("." for the root), so the
	 * CLI, which trims whitespace around `--cwd`, keeps a name that begins or
	 * ends with a space. Refuses a path outside the root.
	 */
	#relative(cwd: string): string {
		if (!path.posix.isAbsolute(cwd) || cwd.includes("\0")) throw new BackendError("INVALID_PATH", cwd, `sandbox paths must be absolute: ${cwd}`);
		const relative = path.posix.relative(this.root, path.posix.normalize(cwd));
		if (relative === "") return ".";
		if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
			throw new BackendError("OUTSIDE_ROOT", cwd, `path is outside the sandbox root: ${cwd}`);
		}
		return `./${relative}/.`;
	}
}

async function readStatus(file: string): Promise<ExecStatus | undefined> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}
	const value = JSON.parse(text) as Partial<ExecStatus>;
	return { exit_code: value.exit_code ?? null, signal: value.signal ?? null, timed_out: value.timed_out === true, error: value.error ?? null };
}

function homeArgs(home: string | undefined): string[] {
	return home === undefined ? [] : ["--home", home];
}

function parseWorkspace(stdout: string): WorkspaceInfo {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new Error(`gitmoot workspace show printed no JSON: ${stdout.slice(0, 200)}`);
	}
	const field = (name: string): string => {
		const v = value !== null && typeof value === "object" && name in value ? (value as Record<string, unknown>)[name] : undefined;
		if (typeof v !== "string" || v === "") throw new Error(`gitmoot workspace show: missing ${name}`);
		return v;
	};
	const info: WorkspaceInfo = { id: field("id"), root: field("root"), state: field("state"), provider: field("provider") };
	if (!path.posix.isAbsolute(info.root)) throw new Error(`gitmoot workspace show: root ${info.root} is not absolute`);
	return info;
}

/** Run the CLI and return its stdout; its own failures become GitmootCliError. */
async function runCli(bin: string, args: string[], label: string): Promise<string> {
	const result = await callCli(bin, args, label);
	if (result.code !== 0) throw result.code === CLI_FAILURE ? cliError(label, result.stderr) : new Error(`gitmoot ${label} exited ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
	return new TextDecoder().decode(result.stdout);
}

/** Run the CLI with optional stdin bytes; the raw exit code, stdout bytes and stderr text. */
function callCli(bin: string, args: string[], label: string, stdin?: Uint8Array): Promise<{ code: number | null; stdout: Uint8Array; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on("data", chunk => out.push(chunk));
		child.stderr?.on("data", chunk => err.push(chunk));
		child.on("error", error => reject(new Error(`gitmoot ${label}: ${error.message}`)));
		child.on("close", code => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
		if (stdin !== undefined) {
			// EPIPE when the CLI refuses early: its exit code says why.
			child.stdin?.on("error", () => {});
			child.stdin?.end(stdin);
		}
	});
}

function cliError(label: string, stderr: string): Error {
	for (const line of stderr.trim().split("\n").reverse()) {
		try {
			const parsed = JSON.parse(line) as { error?: { code?: unknown; message?: unknown } };
			if (typeof parsed.error?.code === "string") return new GitmootCliError(label, parsed.error.code, String(parsed.error.message ?? ""));
		} catch {
			// not the error line
		}
	}
	return new Error(`gitmoot ${label} failed: ${stderr.trim().slice(0, 300)}`);
}
