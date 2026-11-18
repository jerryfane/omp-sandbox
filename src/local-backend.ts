import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Backend,
	BackendError,
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
 * How long to keep reading after the shell exits. A command that starts a
 * background process (`sleep 99 &`) leaves our pipes open; past this grace
 * period we stop reading instead of waiting for it, the way a remote sandbox
 * would leave it running in the VM.
 */
const EXIT_DRAIN_MS = 250;

/**
 * A test stand-in for a sandbox: the "sandbox" is a directory on this host and
 * commands run as local subprocesses with that directory as their world.
 *
 * File operations are confined to the root (symlinks included), because
 * outside the root is the host, which is exactly what tests must prove the
 * tools never touch. Commands are NOT confined: `exec` is a host subprocess
 * and can read anything the current user can. LocalBackend is for tests, not
 * for isolation.
 */
export class LocalBackend implements Backend {
	readonly name = "local";
	readonly root: string;

	private constructor(root: string) {
		this.root = root;
	}

	/** `root` must be an existing directory; its real path becomes the sandbox root. */
	static async create(root: string): Promise<LocalBackend> {
		const real = await fs.realpath(root);
		const info = await fs.stat(real);
		if (!info.isDirectory()) {
			throw new BackendError("ENOTDIR", root, `local backend root is not a directory: ${root}`);
		}
		return new LocalBackend(real);
	}

	async exec(command: string, options: ExecOptions): Promise<ExecResult> {
		const cwd = await this.realInside(options.cwd);
		const info = await fs.stat(cwd).catch(() => null);
		if (!info?.isDirectory()) {
			throw new BackendError("ENOTDIR", options.cwd, `cwd is not a directory: ${options.cwd}`);
		}
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

		const child = spawn("bash", ["-c", command], {
			cwd,
			env: { ...BASE_ENV, HOME: this.root, ...options.env },
			detached: true, // own process group, so a kill reaches every descendant
			stdio: ["ignore", "pipe", "pipe"],
		});
		const killGroup = () => {
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// already gone
			}
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
						killGroup();
					}, options.timeoutMs);
		const onAbort = () => {
			result.aborted = true;
			killGroup();
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
		const real = await this.realInside(file);
		try {
			return new Uint8Array(await fs.readFile(real));
		} catch (error) {
			throw mapFsError(error, file);
		}
	}

	async writeFile(file: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void> {
		const target = await this.realInside(file);
		try {
			await fs.mkdir(path.dirname(target), { recursive: true });
			// Created directories must still be inside: a symlinked parent could
			// have redirected mkdir, so check again before writing.
			await this.realInside(file);
			await fs.writeFile(target, data, options?.mode === undefined ? undefined : { mode: options.mode });
		} catch (error) {
			throw mapFsError(error, file);
		}
	}

	async stat(file: string): Promise<FileStat | null> {
		const target = await this.realParentInside(file);
		try {
			return toStat(file, await fs.lstat(target));
		} catch (error) {
			if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return null;
			throw mapFsError(error, file);
		}
	}

	async list(dir: string, options: ListOptions = {}): Promise<ListResult> {
		const realDir = await this.realInside(dir);
		const limit = options.limit ?? Number.POSITIVE_INFINITY;
		const entries: FileStat[] = [];
		let truncated = false;

		const walk = async (sandboxDir: string, hostDir: string): Promise<void> => {
			let names: string[];
			try {
				names = (await fs.readdir(hostDir)).sort();
			} catch (error) {
				throw mapFsError(error, sandboxDir);
			}
			for (const name of names) {
				if (entries.length >= limit) {
					truncated = true;
					return;
				}
				const sandboxPath = path.posix.join(sandboxDir, name);
				const hostPath = path.join(hostDir, name);
				const info = toStat(sandboxPath, await fs.lstat(hostPath));
				entries.push(info);
				// Never follow a symlinked directory: it may point outside the root.
				if (options.recursive && info.type === "dir") {
					await walk(sandboxPath, hostPath);
					if (truncated) return;
				}
			}
		};
		await walk(normalizeAbsolute(dir), realDir);
		return { entries, truncated };
	}

	async close(): Promise<void> {}

	/** Resolve `file` (following symlinks as far as it exists) and require it inside the root. */
	private async realInside(file: string): Promise<string> {
		const lexical = this.lexicalInside(file);
		const real = await realpathOfExisting(lexical);
		if (!isWithin(this.root, real)) {
			throw new BackendError("OUTSIDE_ROOT", file, `path resolves outside the sandbox root: ${file}`);
		}
		return real;
	}

	/** Like realInside, but the final component itself is not followed (lstat semantics). */
	private async realParentInside(file: string): Promise<string> {
		const lexical = this.lexicalInside(file);
		if (lexical === this.root) return lexical;
		const parent = await realpathOfExisting(path.dirname(lexical));
		if (!isWithin(this.root, parent)) {
			throw new BackendError("OUTSIDE_ROOT", file, `path resolves outside the sandbox root: ${file}`);
		}
		return path.join(parent, path.basename(lexical));
	}

	private lexicalInside(file: string): string {
		const normalized = normalizeAbsolute(file);
		if (!isWithin(this.root, normalized)) {
			throw new BackendError("OUTSIDE_ROOT", file, `path is outside the sandbox root: ${file}`);
		}
		return normalized;
	}
}

function normalizeAbsolute(file: string): string {
	if (!path.posix.isAbsolute(file) || file.includes("\0")) {
		throw new BackendError("INVALID_PATH", file, `sandbox paths must be absolute: ${file}`);
	}
	const normalized = path.posix.normalize(file);
	return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isWithin(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** realpath of the longest existing prefix of `file`, with the missing rest appended. */
async function realpathOfExisting(file: string): Promise<string> {
	const missing: string[] = [];
	let current = file;
	for (;;) {
		try {
			const real = await fs.realpath(current);
			return missing.length === 0 ? real : path.join(real, ...missing.reverse());
		} catch (error) {
			if (!isCode(error, "ENOENT") && !isCode(error, "ENOTDIR")) throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			missing.push(path.basename(current));
			current = parent;
		}
	}
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

function mapFsError(error: unknown, file: string): unknown {
	if (error instanceof BackendError) return error;
	if (isCode(error, "ENOENT")) return new BackendError("ENOENT", file, `no such file: ${file}`);
	if (isCode(error, "EISDIR")) return new BackendError("EISDIR", file, `is a directory: ${file}`);
	if (isCode(error, "ENOTDIR")) return new BackendError("ENOTDIR", file, `not a directory: ${file}`);
	return error;
}
