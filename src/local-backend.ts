import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, readdirSync, readFileSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import { constants as osConstants } from "node:os";
import * as path from "node:path";
import {
	type Backend,
	BackendError,
	type BackendErrorCode,
	type Changes,
	DEFAULT_MAX_OUTPUT_BYTES,
	type ExecOptions,
	type ExecResult,
	type FileStat,
	type FileType,
	type ListOptions,
	type ListResult,
	type OutputStream,
	type ShellCommandOptions,
	type SyncFile,
	type TreeEntry,
} from "./backend.ts";

/** Environment every LocalBackend command starts from. Nothing comes from the host. */
const BASE_ENV: Readonly<Record<string, string>> = {
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	LANG: "C.UTF-8",
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quote `text` as one POSIX shell word. */
function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * In process-tree mode, how long to keep reading after the shell exits. A
 * command that leaves a background process running (`sleep 99 &`) keeps our
 * pipes open; past this grace period we stop reading instead of waiting.
 */
const EXIT_DRAIN_MS = 250;

const O_DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const O_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const O_WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const O_CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** How many `changes` tokens LocalBackend remembers; an older one gets a full listing. */
const MAX_TOKENS = 8;

/**
 * The pid-namespace "init" (PID 1), a small Python program. It runs the
 * command as its child, so the command is not PID 1 and keeps normal signal
 * behaviour, reaps orphans, and exits with the command's status. When it
 * exits, the kernel kills everything left in the namespace.
 *
 * A shell init cannot tell "killed by SIGTERM" from "exit 143", so when the
 * command dies of a signal the init writes the signal number to its report
 * file (argv[1]; "-" for none), in a fresh 0700 directory the backend made
 * for that one command. It prints nothing of its own, except when bash cannot
 * be started at all. Its exit status is the command's, or 128+n for signal n.
 * (A file, not an inherited pipe: Bun emulates extra stdio pipes over a Unix
 * socket whose connect intermittently fails under load.) A command running as
 * the same user could find and overwrite that file; LocalBackend isolates
 * nothing.
 *
 * Python ignores SIGPIPE and SIGXFSZ at startup, and exec keeps an ignored
 * disposition, so the child resets every signal to its default before exec:
 * the command must see the same signals it would without the init.
 */
const NAMESPACE_INIT = `import os, signal, sys
report_path = None if sys.argv[1] == "-" else sys.argv[1]
def report(text):
    if report_path is None:
        return
    try:
        fd = os.open(report_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        os.write(fd, text)
        os.close(fd)
    except OSError:
        pass
pid = os.fork()
if pid == 0:
    for number in signal.valid_signals():
        try:
            signal.signal(number, signal.SIG_DFL)
        except (OSError, ValueError):
            pass
    try:
        os.execv("/bin/bash", ["bash", "-c", sys.argv[2]])
    except OSError as error:
        os.write(2, ("omp-sandbox: cannot start bash: %s\\n" % error).encode())
        os._exit(127)
while True:
    try:
        done, status = os.waitpid(-1, 0)
    except ChildProcessError:
        os._exit(127)
    if done == pid:
        break
if os.WIFSIGNALED(status):
    report(b"%d" % os.WTERMSIG(status))
    os._exit(128 + os.WTERMSIG(status))
os._exit(os.WEXITSTATUS(status))
`;

/**
 * Always a user namespace too, also when running as root, so the namespace
 * never holds real root (machine rule: no real-root namespace experiments on
 * live hosts). Run as root, the namespace's uid 0 still maps to the real uid
 * 0, so root-owned files stay accessible, but its capabilities are confined to
 * the new namespaces. Never a mount namespace or a /proc remount.
 */
const NAMESPACE_FLAGS: readonly string[] = ["--user", "--map-root-user", "--pid", "--fork", "--kill-child"];

/**
 * `unshare <flags> -- python3 -I -S -c NAMESPACE_INIT <report-file> <command>`:
 * absolute paths, Python in isolated mode with no site import.
 */
function namespaceArgv(reportFile: string, command: string): string[] {
	return ["/usr/bin/unshare", ...NAMESPACE_FLAGS, "--", "/usr/bin/python3", "-I", "-S", "-c", NAMESPACE_INIT, reportFile, command];
}

const SIGNAL_NAMES: ReadonlyMap<number, NodeJS.Signals> = new Map(
	Object.entries(osConstants.signals).map(([name, number]) => [number, name as NodeJS.Signals]),
);

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
	/** Tree fingerprints by `changes` token, oldest first. */
	readonly #manifests = new Map<string, Map<string, string>>();

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

		const full = this.containment === "full";
		const env = this.#environment(options.env);
		const statusDir = full ? await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-status-")) : undefined;
		try {
			return await this.#run(command, cwd, env, limit, result, options, statusDir === undefined ? undefined : path.join(statusDir, "signal"));
		} finally {
			// Also after a synchronous spawn failure (E2BIG, ENOENT) inside #run.
			if (statusDir !== undefined) await fs.rm(statusDir, { recursive: true, force: true });
		}
	}

	/** Spawns the command (in the namespace when `statusFile` is set) and collects the result. */
	async #run(
		command: string,
		cwd: string,
		env: Record<string, string>,
		limit: number,
		result: ExecResult,
		options: ExecOptions,
		statusFile: string | undefined,
	): Promise<ExecResult> {
		const [file, ...args] = statusFile === undefined ? ["/bin/bash", "-c", command] : namespaceArgv(statusFile, command);
		if (file === undefined) throw new Error("empty argv");
		// The environment goes in as `env -i NAME=VALUE` arguments, as in
		// shellCommand: Bun's async spawn drops an entry named `__proto__` from
		// an env object, even a null-prototype one. env execs, so the pid and
		// process group are the command's.
		const child = spawn("/usr/bin/env", ["-i", ...Object.entries(env).map(([name, value]) => `${name}=${value}`), file, ...args], {
			cwd,
			env: {},
			detached: true, // own process group
			stdio: ["ignore", "pipe", "pipe"],
		});
		const { stdout, stderr } = child;
		if (stdout === null || stderr === null) throw new Error("spawned with piped stdout and stderr");
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
		stdout.on("data", capture("stdout"));
		stderr.on("data", capture("stderr"));

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
				stdout.destroy();
				stderr.destroy();
				done.resolve();
			}, EXIT_DRAIN_MS);
		});
		child.once("close", () => {
			clearTimeout(drain);
			done.resolve();
		});
		let reportedText = "";
		try {
			await done.promise;
			if (statusFile !== undefined) reportedText = await fs.readFile(statusFile, "utf8").catch(() => "");
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
		// The init survived and reported that the command itself died of a signal.
		const reported = SIGNAL_NAMES.get(Number.parseInt(reportedText, 10));
		if (statusFile !== undefined && result.signal === null && reported !== undefined) {
			result.exitCode = null;
			result.signal = reported;
		}
		return result;
	}

	shellCommand(command: string, options: ShellCommandOptions): string {
		// Lexical check only (this is synchronous and touches nothing): the
		// cwd must be inside the root. `env -C` refuses one that is missing.
		this.#components(options.cwd);
		const cwd = normalizeAbsolute(options.cwd);
		const env = Object.entries(this.#environment(options.env)).map(([name, value]) => shellQuote(`${name}=${value}`));
		const program =
			this.containment === "full" ? namespaceArgv("-", command) : ["/bin/bash", "-c", command];
		// `env -i -C`: an empty environment plus our own, and the cwd, without a
		// leading `cd` and without the host shell's in-process `env`.
		return ["/usr/bin/env", "-i", "-C", shellQuote(cwd), ...env, ...program.map(shellQuote)].join(" ");
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
				// Re-opened with O_NOFOLLOW. Removed, or replaced by a symlink or a
				// file since lstat: not entered. Anything else (permissions,
				// resource limits) is an error, never a silently shorter listing.
				const child = await fs.open(at(dirFd, name), O_DIR).catch((error: unknown) => {
					if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR") || isCode(error, "ELOOP")) return undefined;
					throw mapFsError(error, sandboxPath);
				});
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

	async changes(since?: string): Promise<Changes> {
		const entries = new Map<string, { entry: TreeEntry; fingerprint: string }>();
		const walk = async (dirFd: number, rel: string): Promise<void> => {
			let names: string[];
			try {
				names = await fs.readdir(at(dirFd, "."));
			} catch (error) {
				throw mapFsError(error, path.posix.join(this.root, rel));
			}
			for (const name of names) {
				if (rel === "" && name === ".git") continue;
				const childRel = rel === "" ? name : `${rel}/${name}`;
				let info: Stats;
				try {
					info = await fs.lstat(at(dirFd, name));
				} catch (error) {
					if (isCode(error, "ENOENT")) continue; // removed while walking
					throw mapFsError(error, path.posix.join(this.root, childRel));
				}
				const { type } = toStat(childRel, info);
				const entry: TreeEntry = { path: childRel, type, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode & 0o7777 };
				// A directory's size and mtime move with its children; only its identity and mode matter.
				const fingerprint =
					type === "dir" ? `dir:${info.ino}:${entry.mode}` : `${type}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${entry.mode}`;
				entries.set(childRel, { entry, fingerprint });
				if (type !== "dir") continue;
				// Same rule as list: re-opened with O_NOFOLLOW, and not entered when it changed meanwhile.
				const child = await fs.open(at(dirFd, name), O_DIR).catch((error: unknown) => {
					if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR") || isCode(error, "ELOOP")) return undefined;
					throw mapFsError(error, path.posix.join(this.root, childRel));
				});
				if (child === undefined) continue;
				try {
					await walk(child.fd, childRel);
				} finally {
					await child.close();
				}
			}
		};
		const rootHandle = await this.#openDir([], this.root, false);
		try {
			await walk(rootHandle.fd, "");
		} finally {
			await rootHandle.close();
		}

		const current = new Map<string, string>();
		for (const [rel, { fingerprint }] of entries) current.set(rel, fingerprint);
		const previous = since === undefined ? undefined : this.#manifests.get(since);
		const token = randomUUID();
		this.#manifests.set(token, current);
		for (const old of this.#manifests.keys()) {
			if (this.#manifests.size <= MAX_TOKENS) break;
			this.#manifests.delete(old);
		}
		const all = [...entries.values()];
		const changed = (previous === undefined ? all : all.filter(({ entry, fingerprint }) => previous.get(entry.path) !== fingerprint)).map(e => e.entry);
		const deleted = previous === undefined ? [] : [...previous.keys()].filter(rel => !current.has(rel));
		changed.sort((a, b) => byteOrder(a.path, b.path));
		deleted.sort(byteOrder);
		return { token, full: previous === undefined, changed, deleted };
	}

	async pull(paths: readonly string[]): Promise<SyncFile[]> {
		const files: SyncFile[] = [];
		for (const rel of paths) {
			const parts = relativeComponents(rel);
			const file = path.posix.join(this.root, ...parts);
			const dir = await this.#openDir(parts.slice(0, -1), file, false).catch((error: unknown) => {
				if (isGone(error)) return undefined;
				throw error;
			});
			if (dir === undefined) continue;
			try {
				const handle = await fs.open(at(dir.fd, parts.at(-1) as string), O_READ).catch((error: unknown) => {
					if (isCode(error, "ENOENT") || isCode(error, "ELOOP") || isCode(error, "ENXIO")) return undefined;
					throw mapFsError(error, file);
				});
				if (handle === undefined) continue;
				try {
					const info = await handle.stat();
					if (!info.isFile()) continue;
					files.push({ path: parts.join("/"), mode: info.mode & 0o7777, data: new Uint8Array(await handle.readFile()) });
				} finally {
					await handle.close();
				}
			} finally {
				await dir.close();
			}
		}
		return files;
	}

	async push(files: readonly SyncFile[]): Promise<void> {
		for (const entry of files) {
			const parts = relativeComponents(entry.path);
			const name = parts.at(-1) as string;
			const file = path.posix.join(this.root, ...parts);
			const dir = await this.#openDir(parts.slice(0, -1), file, true);
			try {
				const existing = await fs.lstat(at(dir.fd, name)).catch((error: unknown) => {
					if (isCode(error, "ENOENT")) return undefined;
					throw mapFsError(error, file);
				});
				if (existing?.isSymbolicLink()) throw new BackendError("SYMLINK", file, `will not replace a symlink: ${file}`);
				if (existing?.isDirectory()) throw new BackendError("EISDIR", file, `is a directory: ${file}`);
				// Written next to the target and renamed over it: readers see old or new, never a mix.
				const temp = `.omp-sandbox-push-${randomUUID()}`;
				const handle = await fs.open(at(dir.fd, temp), O_CREATE_NEW, 0o600).catch((error: unknown) => {
					throw mapFsError(error, file);
				});
				try {
					try {
						await handle.writeFile(entry.data);
						await handle.chmod(entry.mode);
					} finally {
						await handle.close();
					}
					await fs.rename(at(dir.fd, temp), at(dir.fd, name));
				} catch (error) {
					await fs.unlink(at(dir.fd, temp)).catch(() => undefined);
					throw mapFsError(error, file);
				}
			} finally {
				await dir.close();
			}
		}
	}

	async remove(paths: readonly string[]): Promise<void> {
		for (const rel of paths) {
			const parts = relativeComponents(rel);
			const name = parts.at(-1) as string;
			const file = path.posix.join(this.root, ...parts);
			const dir = await this.#openDir(parts.slice(0, -1), file, false).catch((error: unknown) => {
				if (isGone(error)) return undefined;
				throw error;
			});
			if (dir === undefined) continue;
			try {
				const info = await fs.lstat(at(dir.fd, name)).catch((error: unknown) => {
					if (isCode(error, "ENOENT")) return undefined;
					throw mapFsError(error, file);
				});
				if (info === undefined) continue;
				if (info.isDirectory()) {
					await fs.rmdir(at(dir.fd, name)).catch((error: unknown) => {
						// Not empty: the sandbox has new content there, which stays.
						if (isCode(error, "ENOENT") || isCode(error, "ENOTEMPTY") || isCode(error, "EEXIST")) return;
						throw mapFsError(error, file);
					});
				} else {
					await fs.unlink(at(dir.fd, name)).catch((error: unknown) => {
						if (!isCode(error, "ENOENT")) throw mapFsError(error, file);
					});
				}
			} finally {
				await dir.close();
			}
		}
	}

	async close(): Promise<void> {
		await this.#rootDir.close();
	}

	/**
	 * The environment a command starts from: BASE_ENV, HOME, then `extra`.
	 * A null-prototype record, so a name like `__proto__` is an ordinary entry.
	 */
	#environment(extra: Record<string, string> | undefined): Record<string, string> {
		const env: Record<string, string> = Object.assign(Object.create(null), BASE_ENV, { HOME: this.root });
		for (const [name, value] of Object.entries(extra ?? {})) {
			if (!ENV_NAME.test(name) || value.includes("\0")) {
				throw new BackendError("INVALID_ENV", name, `invalid environment variable: ${name}`);
			}
			env[name] = value;
		}
		return env;
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

/** A path's parent is gone, or is reached through a symlink: the path does not exist in the tree. */
function isGone(error: unknown): boolean {
	return error instanceof BackendError && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "SYMLINK");
}

/** The components of a workspace-relative path; refuses absolute, empty, `.` and `..` components. */
function relativeComponents(rel: string): string[] {
	const parts = rel.split("/");
	if (rel === "" || rel.includes("\0") || parts.some(part => part === "" || part === "." || part === "..")) {
		throw new BackendError("INVALID_PATH", rel, `workspace paths must be relative, without empty, . or .. components: ${rel}`);
	}
	return parts;
}

function byteOrder(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

let pidNamespaceSupport: boolean | undefined;

/** Whether `unshare` can run the namespace init here (probed once per process). */
function canCreatePidNamespace(): boolean {
	if (pidNamespaceSupport === undefined) {
		const [file, ...args] = namespaceArgv("-", "true");
		pidNamespaceSupport = file !== undefined && spawnSync(file, args, { stdio: "ignore" }).status === 0;
	}
	return pidNamespaceSupport;
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
	EACCES: "EACCES",
	EPERM: "EACCES",
};

function mapFsError(error: unknown, file: string): unknown {
	if (error instanceof BackendError) return error;
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	const mapped = FS_CODES[code];
	return mapped === undefined ? error : new BackendError(mapped, file, `${mapped}: ${file}`);
}
