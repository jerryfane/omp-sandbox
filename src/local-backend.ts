import { spawn, spawnSync } from "node:child_process";
import { constants, readdirSync, readFileSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import {
	type Backend,
	BackendError,
	type BackendErrorCode,
	DEFAULT_MAX_OUTPUT_BYTES,
	type ExecOptions,
	type ExecResult,
	type FileStat,
	type FileType,
	type ListOptions,
	type ListResult,
	type OutputStream,
} from "./backend.ts";

/** Environment every LocalBackend command starts from. Nothing comes from the host. */
const BASE_ENV: Readonly<Record<string, string>> = {
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	LANG: "C.UTF-8",
};

/**
 * In process-tree mode, how long to keep reading after the shell exits. A
 * command that leaves a background process running (`sleep 99 &`) keeps our
 * pipes open; past this grace period we stop reading instead of waiting.
 */
const EXIT_DRAIN_MS = 250;

const O_DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const O_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const O_WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * The pid-namespace "init": runs the command as its child (so the command is
 * not PID 1 and keeps normal signal behaviour) and exits with its status. When
 * it exits, the kernel kills everything left in the namespace.
 */
const NAMESPACE_INIT = 'bash -c "$1" omp-sandbox; status=$?; exit "$status"';

/** A sandbox path below `dir`, resolved through an open directory descriptor. */
function at(dirFd: number, name: string): string {
	return `/proc/self/fd/${dirFd}/${name}`;
}

export interface LocalBackendOptions {
	/**
	 * Force a containment mode. Default: "full" when this host can create a
	 * pid namespace (`unshare`), otherwise "process-tree".
	 */
	containment?: "full" | "process-tree";
}

/**
 * A test stand-in for a sandbox: a directory on this host is the sandbox.
 *
 * File operations are confined to that directory. Every path is resolved one
 * component at a time from an open descriptor of the root, with O_NOFOLLOW,
 * so no symlink is ever followed and a concurrent rename cannot redirect an
 * operation outside the root. A path through a symlink fails with
 * BackendError("SYMLINK"), even one that stays inside the root.
 *
 * Commands are NOT confined: `exec` runs a host subprocess that can read
 * anything the current user can. With containment "full" it runs in its own
 * pid namespace. LocalBackend is for tests, not for isolation. Linux only.
 */
export class LocalBackend implements Backend {
	readonly name = "local";
	readonly root: string;
	readonly containment: "full" | "process-tree";
	readonly #rootDir: FileHandle;

	private constructor(root: string, rootDir: FileHandle, containment: "full" | "process-tree") {
		this.root = root;
		this.#rootDir = rootDir;
		this.containment = containment;
	}

	/** `root` must be an existing directory; its real path becomes the sandbox root. */
	static async create(root: string, options: LocalBackendOptions = {}): Promise<LocalBackend> {
		const real = await fs.realpath(root);
		let rootDir: FileHandle;
		try {
			rootDir = await fs.open(real, O_DIR);
		} catch (error) {
			throw mapFsError(error, root);
		}
		const supported = canCreatePidNamespace();
		const containment = options.containment ?? (supported ? "full" : "process-tree");
		if (containment === "full" && !supported) {
			await rootDir.close();
			throw new Error("containment 'full' needs a pid namespace, and unshare cannot create one here");
		}
		return new LocalBackend(real, rootDir, containment);
	}

	async exec(command: string, options: ExecOptions): Promise<ExecResult> {
		// Validate the cwd (exists, a directory, inside, no symlinks); the
		// command itself is a host process and is not confined to it.
		await (await this.#openDir(this.#components(options.cwd), options.cwd, false)).close();
		const cwd = normalizeAbsolute(options.cwd);
		const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		const result: ExecResult = {
			exitCode: null,
			signal: null,
			stdout: "",
			stderr: "",
			truncated: false,
			timedOut: false,
			aborted: false,
		};
		if (options.signal?.aborted) {
			result.aborted = true;
			return result;
		}

		const [file, args] =
			this.containment === "full"
				? (["unshare", [...namespaceFlags(), "--", "bash", "-c", NAMESPACE_INIT, "omp-sandbox-init", command]] as const)
				: (["bash", ["-c", command]] as const);
		const child = spawn(file, args, {
			cwd,
			env: { ...BASE_ENV, HOME: this.root, ...options.env },
			detached: true, // own process group
			stdio: ["ignore", "pipe", "pipe"],
		});
		const kill = () => {
			if (child.pid !== undefined) killTree(child.pid);
		};

		const capture = (stream: OutputStream) => {
			const decoder = new TextDecoder();
			let bytes = 0;
			return (chunk: Buffer) => {
				if (bytes >= limit) {
					result.truncated = true;
					return;
				}
				let piece = chunk;
				if (bytes + chunk.length > limit) {
					piece = chunk.subarray(0, limit - bytes);
					result.truncated = true;
				}
				bytes += piece.length;
				const text = decoder.decode(piece, { stream: true });
				if (text === "") return;
				result[stream] += text;
				options.onOutput?.(text, stream);
			};
		};
		child.stdout.on("data", capture("stdout"));
		child.stderr.on("data", capture("stderr"));

		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						result.timedOut = true;
						kill();
					}, options.timeoutMs);
		const onAbort = () => {
			result.aborted = true;
			kill();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const done = Promise.withResolvers<void>();
		let drain: NodeJS.Timeout | undefined;
		child.once("error", done.reject);
		child.once("exit", (code, signal) => {
			result.exitCode = code;
			result.signal = signal;
			drain = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				done.resolve();
			}, EXIT_DRAIN_MS);
		});
		child.once("close", () => {
			clearTimeout(drain);
			done.resolve();
		});
		try {
			await done.promise;
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
		return result;
	}

	async readFile(file: string): Promise<Uint8Array> {
		const parts = this.#components(file);
		const name = parts.at(-1);
		if (name === undefined) throw new BackendError("EISDIR", file, `is a directory: ${file}`);
		const dir = await this.#openDir(parts.slice(0, -1), file, false);
		try {
			const handle = await fs.open(at(dir.fd, name), O_READ).catch((error: unknown) => {
				throw mapFsError(error, file);
			});
			try {
				requireRegular(await handle.stat(), file);
				return new Uint8Array(await handle.readFile());
			} finally {
				await handle.close();
			}
		} finally {
			await dir.close();
		}
	}

	async writeFile(file: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void> {
		const parts = this.#components(file);
		const name = parts.at(-1);
		if (name === undefined) throw new BackendError("EISDIR", file, `is a directory: ${file}`);
		const dir = await this.#openDir(parts.slice(0, -1), file, true);
		try {
			const handle = await fs.open(at(dir.fd, name), O_WRITE, options?.mode ?? 0o666).catch((error: unknown) => {
				throw mapFsError(error, file);
			});
			try {
				requireRegular(await handle.stat(), file);
				await handle.writeFile(data);
				if (options?.mode !== undefined) await handle.chmod(options.mode);
			} finally {
				await handle.close();
			}
		} finally {
			await dir.close();
		}
	}

	async stat(file: string): Promise<FileStat | null> {
		const parts = this.#components(file);
		const name = parts.at(-1);
		if (name === undefined) return toStat(this.root, await this.#rootDir.stat());
		let dir: FileHandle;
		try {
			dir = await this.#openDir(parts.slice(0, -1), file, false);
		} catch (error) {
			if (error instanceof BackendError && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
			throw error;
		}
		try {
			return toStat(normalizeAbsolute(file), await fs.lstat(at(dir.fd, name)));
		} catch (error) {
			if (isCode(error, "ENOENT")) return null;
			throw mapFsError(error, file);
		} finally {
			await dir.close();
		}
	}

	async list(dir: string, options: ListOptions = {}): Promise<ListResult> {
		const handle = await this.#openDir(this.#components(dir), dir, false);
		const entries: FileStat[] = [];
		// LocalBackend reads the whole requested tree and then sorts, so `limit`
		// bounds the result, not the work.
		const walk = async (dirFd: number, sandboxDir: string): Promise<void> => {
			let names: string[];
			try {
				names = await fs.readdir(at(dirFd, "."));
			} catch (error) {
				throw mapFsError(error, sandboxDir);
			}
			for (const name of names) {
				const sandboxPath = path.posix.join(sandboxDir, name);
				let info: FileStat;
				try {
					info = toStat(sandboxPath, await fs.lstat(at(dirFd, name)));
				} catch (error) {
					if (isCode(error, "ENOENT")) continue; // removed while listing
					throw mapFsError(error, sandboxPath);
				}
				entries.push(info);
				if (!options.recursive || info.type !== "dir") continue;
				// Re-opened with O_NOFOLLOW: if it became a symlink since lstat,
				// it is not entered.
				const child = await fs.open(at(dirFd, name), O_DIR).catch(() => undefined);
				if (child === undefined) continue;
				try {
					await walk(child.fd, sandboxPath);
				} finally {
					await child.close();
				}
			}
		};
		try {
			await walk(handle.fd, normalizeAbsolute(dir));
		} finally {
			await handle.close();
		}
		entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
		const limit = options.limit ?? Number.POSITIVE_INFINITY;
		return entries.length > limit ? { entries: entries.slice(0, limit), truncated: true } : { entries, truncated: false };
	}

	async close(): Promise<void> {
		await this.#rootDir.close();
	}

	/** The components of `file` below the root; [] for the root itself. */
	#components(file: string): string[] {
		const normalized = normalizeAbsolute(file);
		const prefix = this.root === "/" ? "/" : `${this.root}/`;
		if (normalized === this.root) return [];
		if (!normalized.startsWith(prefix)) {
			throw new BackendError("OUTSIDE_ROOT", file, `path is outside the sandbox root: ${file}`);
		}
		return normalized.slice(prefix.length).split("/");
	}

	/**
	 * Open the directory `parts` below the root, one component at a time with
	 * O_NOFOLLOW, creating missing ones when `create` is set. The caller owns
	 * the returned handle.
	 */
	async #openDir(parts: readonly string[], file: string, create: boolean): Promise<FileHandle> {
		let current = await fs.open(at(this.#rootDir.fd, "."), O_DIR);
		try {
			for (const name of parts) {
				const next = await openChildDir(current.fd, name, file, create);
				await current.close();
				current = next;
			}
			return current;
		} catch (error) {
			await current.close();
			throw error;
		}
	}
}

async function openChildDir(dirFd: number, name: string, file: string, create: boolean): Promise<FileHandle> {
	try {
		return await fs.open(at(dirFd, name), O_DIR);
	} catch (error) {
		if (create && isCode(error, "ENOENT")) {
			await fs.mkdir(at(dirFd, name)).catch((mkdirError: unknown) => {
				if (!isCode(mkdirError, "EEXIST")) throw mapFsError(mkdirError, file);
			});
			return await fs.open(at(dirFd, name), O_DIR).catch(async (reopenError: unknown) => {
				throw await classifyNotDir(reopenError, dirFd, name, file);
			});
		}
		throw await classifyNotDir(error, dirFd, name, file);
	}
}

/**
 * O_DIRECTORY|O_NOFOLLOW fails with ENOTDIR for both a file and a symlink;
 * lstat tells them apart. Only the error code depends on this, not safety.
 */
async function classifyNotDir(error: unknown, dirFd: number, name: string, file: string): Promise<unknown> {
	if (!isCode(error, "ENOTDIR") && !isCode(error, "ELOOP")) return mapFsError(error, file);
	const info = await fs.lstat(at(dirFd, name)).catch(() => undefined);
	if (info?.isSymbolicLink()) return new BackendError("SYMLINK", file, `path goes through a symlink: ${file}`);
	return new BackendError("ENOTDIR", file, `not a directory: ${file}`);
}

function requireRegular(info: Stats, file: string): void {
	if (info.isDirectory()) throw new BackendError("EISDIR", file, `is a directory: ${file}`);
	if (!info.isFile()) throw new BackendError("NOT_REGULAR", file, `not a regular file: ${file}`);
}

let pidNamespaceSupport: boolean | undefined;

/** Whether `unshare` can create a pid namespace here (probed once per process). */
function canCreatePidNamespace(): boolean {
	pidNamespaceSupport ??= spawnSync("unshare", [...namespaceFlags(), "--", "true"], { stdio: "ignore" }).status === 0;
	return pidNamespaceSupport;
}

function namespaceFlags(): string[] {
	const user = process.getuid?.() === 0 ? [] : ["--user", "--map-root-user"];
	return [...user, "--pid", "--fork", "--kill-child"];
}

/**
 * SIGKILL `rootPid`, every process descended from it, and its process group.
 * Descendants are frozen with SIGSTOP first, round by round until no new one
 * appears, so none can fork or exit (and reparent its children) mid-kill. A
 * descendant whose parent exited before this runs is no longer linked to
 * rootPid and is missed; containment "full" covers that with the namespace.
 */
function killTree(rootPid: number): void {
	const frozen = new Set<number>();
	for (let round = 0; round < 16; round++) {
		let added = false;
		for (const pid of [rootPid, ...descendantsOf(rootPid)]) {
			if (frozen.has(pid)) continue;
			signal(pid, "SIGSTOP");
			frozen.add(pid);
			added = true;
		}
		if (!added) break;
	}
	for (const pid of frozen) signal(pid, "SIGKILL");
	signal(-rootPid, "SIGKILL");
}

function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch {
		// already gone
	}
}

/** Every live process below `rootPid` in the parent tree, from /proc. */
function descendantsOf(rootPid: number): number[] {
	const children = new Map<number, number[]>();
	for (const entry of readdirSync("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid)) continue;
		let stat: string;
		try {
			stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch {
			continue; // exited meanwhile
		}
		// "pid (comm) state ppid ..." — comm may contain spaces and parentheses.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ppid = Number(fields[1]);
		const siblings = children.get(ppid);
		if (siblings === undefined) children.set(ppid, [pid]);
		else siblings.push(pid);
	}
	const found: number[] = [];
	const queue = [...(children.get(rootPid) ?? [])];
	for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
		found.push(pid);
		queue.push(...(children.get(pid) ?? []));
	}
	return found;
}

function normalizeAbsolute(file: string): string {
	if (!path.posix.isAbsolute(file) || file.includes("\0")) {
		throw new BackendError("INVALID_PATH", file, `sandbox paths must be absolute: ${file}`);
	}
	const normalized = path.posix.normalize(file);
	return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function toStat(sandboxPath: string, info: Stats): FileStat {
	let type: FileType = "other";
	if (info.isSymbolicLink()) type = "symlink";
	else if (info.isDirectory()) type = "dir";
	else if (info.isFile()) type = "file";
	return { path: sandboxPath, type, size: info.size, mtimeMs: info.mtimeMs };
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const FS_CODES: Readonly<Record<string, BackendErrorCode>> = {
	ENOENT: "ENOENT",
	EISDIR: "EISDIR",
	ENOTDIR: "ENOTDIR",
	ELOOP: "SYMLINK",
	ENXIO: "NOT_REGULAR", // a FIFO opened for writing with no reader
};

function mapFsError(error: unknown, file: string): unknown {
	if (error instanceof BackendError) return error;
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	const mapped = FS_CODES[code];
	return mapped === undefined ? error : new BackendError(mapped, file, `${mapped}: ${file}`);
}
