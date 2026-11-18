import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Backend, SyncFile } from "./backend.ts";

/** A sync could not keep the host copy and the sandbox consistent; the mirror refuses further work. */
export class MirrorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MirrorError";
	}
}

/** How a path looked on the host at the last sync, by the mirror's own writes or a push. */
interface Known {
	type: "file" | "dir";
	fingerprint: string;
}

interface Scanned {
	type: "file" | "dir" | "symlink" | "other";
	fingerprint: string;
}

/** Files moved per pull or push call, so one call never carries an unbounded batch. */
const BATCH = 256;
const O_CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const O_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const TEMP_PREFIX = ".omp-sandbox-";

/**
 * A host copy of the sandbox's workspace tree, for omp's own file tools to
 * work on. `pullRemote` brings in what changed in the sandbox; `pushLocal`
 * sends what changed here.
 *
 * Only regular files and directories are mirrored. A sandbox symlink or
 * special file is not created here (a symlink could lead a host tool out of
 * the copy), and `.git` is not mirrored.
 *
 * The mirror never deletes or overwrites a host path it did not write itself
 * or that changed here since it last synced: that is a conflict, and like
 * any other sync failure it breaks the mirror. A broken mirror refuses every
 * further sync, so nothing runs against a copy that no longer matches.
 */
export class Mirror {
	readonly hostRoot: string;
	readonly #backend: Backend;
	#token: string | undefined;
	readonly #known = new Map<string, Known>();
	#broken: string | undefined;
	#queue: Promise<unknown> = Promise.resolve();

	private constructor(backend: Backend, hostRoot: string) {
		this.#backend = backend;
		this.hostRoot = hostRoot;
	}

	/**
	 * `hostRoot` must be an existing, empty directory: the first pull fills it,
	 * and nothing already there could be told apart from the sandbox's files.
	 */
	static async create(backend: Backend, hostRoot: string): Promise<Mirror> {
		const real = await fs.realpath(hostRoot);
		const info = await fs.stat(real);
		if (!info.isDirectory()) throw new MirrorError(`the workspace copy ${hostRoot} is not a directory`);
		const existing = await fs.readdir(real);
		if (existing.length > 0) {
			throw new MirrorError(`the workspace copy ${hostRoot} must start empty (it holds ${existing.length} entries)`);
		}
		return new Mirror(backend, real);
	}

	/** Why the mirror stopped, once a sync failed. */
	get broken(): string | undefined {
		return this.#broken;
	}

	/** Bring the host copy up to date with the sandbox. */
	pullRemote(): Promise<void> {
		return this.#exclusive(() => this.#pull());
	}

	/** Send host-side changes (new, modified and deleted files) to the sandbox. */
	pushLocal(): Promise<void> {
		return this.#exclusive(() => this.#push());
	}

	#exclusive(work: () => Promise<void>): Promise<void> {
		const run = this.#queue.then(async () => {
			if (this.#broken !== undefined) throw new MirrorError(this.#broken);
			try {
				await work();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.#broken = `the workspace copy is out of sync with the sandbox: ${message}`;
				throw new MirrorError(this.#broken);
			}
		});
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async #pull(): Promise<void> {
		const changes = await this.#backend.changes(this.#token);
		let deleted = changes.deleted;
		if (changes.full) {
			const listed = new Set(changes.changed.map(entry => entry.path));
			deleted = [...this.#known.keys()].filter(rel => !listed.has(rel));
		}
		for (const rel of [...deleted].sort(deepestFirst)) await this.#removeHost(rel, "deleted in the sandbox");

		const files: string[] = [];
		for (const entry of changes.changed) {
			const parts = relativeParts(entry.path);
			if (entry.type === "dir") await this.#ensureDir(parts);
			else if (entry.type === "file") files.push(entry.path);
			// A symlink or special file: not mirrored. What the mirror held there goes.
			else await this.#removeHost(entry.path, `a ${entry.type} in the sandbox now`);
		}
		for (let start = 0; start < files.length; start += BATCH) {
			for (const file of await this.#backend.pull(files.slice(start, start + BATCH))) await this.#writeHost(file);
		}
		this.#token = changes.token;
	}

	async #push(): Promise<void> {
		const scan = await this.#scanHost();
		const changed: string[] = [];
		for (const [rel, entry] of scan) {
			if (entry.type === "symlink" || entry.type === "other") {
				throw new MirrorError(`${rel} is a ${entry.type} in the workspace copy; only files and directories are synced`);
			}
			if (entry.type === "file" && this.#known.get(rel)?.fingerprint !== entry.fingerprint) changed.push(rel);
		}
		for (let start = 0; start < changed.length; start += BATCH) {
			const batch: SyncFile[] = [];
			const fingerprints: string[] = [];
			for (const rel of changed.slice(start, start + BATCH)) {
				const read = await this.#readHost(rel);
				if (read === undefined) continue; // removed since the scan; the next push sends that
				batch.push(read.file);
				fingerprints.push(read.fingerprint);
			}
			await this.#backend.push(batch);
			batch.forEach((file, index) => {
				this.#known.set(file.path, { type: "file", fingerprint: fingerprints[index] as string });
				// The sandbox created its parents, so a later delete here must remove them there too.
				const parts = file.path.split("/");
				for (let depth = 1; depth < parts.length; depth++) {
					const parent = parts.slice(0, depth).join("/");
					if (!this.#known.has(parent)) this.#known.set(parent, { type: "dir", fingerprint: "dir" });
				}
			});
		}
		// Directories are removed after their contents: deepest first. An empty
		// directory created here is not sent; the sandbox creates parents itself.
		const removed = [...this.#known.keys()].filter(rel => !scan.has(rel)).sort(deepestFirst);
		for (let start = 0; start < removed.length; start += BATCH) {
			const batch = removed.slice(start, start + BATCH);
			await this.#backend.remove(batch);
			for (const rel of batch) this.#known.delete(rel);
		}
		// Advance the token past what was just sent. Otherwise a file pushed now
		// and deleted in the sandbox before the next pull is in neither the
		// token's manifest nor the sandbox, so `changes` never reports it and the
		// copy keeps it. The echo of the push itself is skipped by #writeHost.
		if (changed.length > 0 || removed.length > 0) await this.#pull();
	}

	/** Remove a host path the mirror wrote, unless it changed here since. */
	async #removeHost(rel: string, why: string): Promise<void> {
		const parts = relativeParts(rel);
		const known = this.#known.get(rel);
		if (known === undefined) return; // never written here: not the mirror's to remove
		const target = await this.#lstatInside(parts);
		if (target === undefined) {
			this.#known.delete(rel);
			return;
		}
		if (known.type === "dir" && target.isDirectory()) {
			try {
				await fs.rmdir(this.#host(parts));
				this.#known.delete(rel);
			} catch (error) {
				// Files created here that are not synced yet: kept, and so is the directory.
				if (!isCode(error, "ENOTEMPTY") && !isCode(error, "EEXIST")) throw error;
			}
			return;
		}
		if (known.type === "file" && target.isFile() && fileFingerprint(target) === known.fingerprint) {
			await fs.unlink(this.#host(parts));
			this.#known.delete(rel);
			return;
		}
		throw new MirrorError(`${rel} was ${why}, but it also changed in the workspace copy`);
	}

	async #ensureDir(parts: readonly string[]): Promise<void> {
		for (let depth = 1; depth <= parts.length; depth++) {
			const prefix = parts.slice(0, depth);
			const rel = prefix.join("/");
			const info = await lstatOrUndefined(this.#host(prefix));
			if (info?.isDirectory()) {
				if (!this.#known.has(rel)) this.#known.set(rel, { type: "dir", fingerprint: "dir" });
				continue;
			}
			if (info !== undefined) {
				// A file the mirror wrote, now a directory in the sandbox.
				await this.#removeHost(rel, "replaced by a directory in the sandbox");
				if ((await lstatOrUndefined(this.#host(prefix))) !== undefined) {
					throw new MirrorError(`${rel} is a directory in the sandbox but not in the workspace copy`);
				}
			}
			await fs.mkdir(this.#host(prefix));
			this.#known.set(rel, { type: "dir", fingerprint: "dir" });
		}
	}

	/** Write a pulled file, unless the host copy holds changes of its own there. */
	async #writeHost(file: SyncFile): Promise<void> {
		const parts = relativeParts(file.path);
		await this.#ensureDir(parts.slice(0, -1));
		const target = this.#host(parts);
		const known = this.#known.get(file.path);
		const info = await lstatOrUndefined(target);
		if (info === undefined) {
			if (known !== undefined) throw new MirrorError(`${file.path} changed in the sandbox, but was deleted in the workspace copy`);
		} else if (info.isDirectory() && known?.type === "dir") {
			// A directory the mirror made, now a file in the sandbox; its contents were deleted first.
			await this.#removeHost(file.path, "replaced by a file in the sandbox");
			if ((await lstatOrUndefined(target)) !== undefined) {
				throw new MirrorError(`${file.path} is a file in the sandbox but a non-empty directory in the workspace copy`);
			}
		} else if (!info.isFile() || known === undefined || fileFingerprint(info) !== known.fingerprint) {
			throw new MirrorError(`${file.path} changed in the sandbox and in the workspace copy`);
		} else if ((info.mode & 0o7777) === file.mode && Buffer.from(await fs.readFile(target)).equals(file.data)) {
			return; // unchanged, e.g. the echo of a push: no rewrite, so its mtime stays
		}
		const temp = this.#host([...parts.slice(0, -1), `${TEMP_PREFIX}pull-${randomUUID()}`]);
		const handle = await fs.open(temp, O_CREATE_NEW, 0o600);
		try {
			try {
				await handle.writeFile(file.data);
				await handle.chmod(file.mode);
			} finally {
				await handle.close();
			}
			await fs.rename(temp, target);
		} catch (error) {
			await fs.unlink(temp).catch(() => undefined);
			throw error;
		}
		this.#known.set(file.path, { type: "file", fingerprint: fileFingerprint(await fs.lstat(target)) });
	}

	/** A host file's contents and the fingerprint of exactly what was read. */
	async #readHost(rel: string): Promise<{ file: SyncFile; fingerprint: string } | undefined> {
		const parts = relativeParts(rel);
		if ((await this.#lstatInside(parts)) === undefined) return undefined;
		const handle = await fs.open(this.#host(parts), O_READ).catch((error: unknown) => {
			if (isCode(error, "ENOENT")) return undefined;
			throw error;
		});
		if (handle === undefined) return undefined;
		try {
			const info = await handle.stat();
			if (!info.isFile()) throw new MirrorError(`${rel} is not a regular file in the workspace copy`);
			const data = new Uint8Array(await handle.readFile());
			return { file: { path: rel, mode: info.mode & 0o7777, data }, fingerprint: fileFingerprint(info) };
		} finally {
			await handle.close();
		}
	}

	/** Every path in the host copy, without following symlinks. */
	async #scanHost(): Promise<Map<string, Scanned>> {
		const found = new Map<string, Scanned>();
		const walk = async (dir: string, rel: string): Promise<void> => {
			for (const name of await fs.readdir(dir)) {
				if (rel === "" && name === ".git") continue;
				if (name.startsWith(TEMP_PREFIX)) continue;
				const childRel = rel === "" ? name : `${rel}/${name}`;
				const info = await lstatOrUndefined(path.join(dir, name));
				if (info === undefined) continue;
				if (info.isDirectory()) {
					found.set(childRel, { type: "dir", fingerprint: "dir" });
					await walk(path.join(dir, name), childRel);
				} else if (info.isFile()) found.set(childRel, { type: "file", fingerprint: fileFingerprint(info) });
				else found.set(childRel, { type: info.isSymbolicLink() ? "symlink" : "other", fingerprint: "" });
			}
		};
		await walk(this.hostRoot, "");
		return found;
	}

	/** lstat of a host path whose parents must be real directories inside the copy; undefined when missing. */
	async #lstatInside(parts: readonly string[]): Promise<Stats | undefined> {
		for (let depth = 1; depth < parts.length; depth++) {
			const info = await lstatOrUndefined(this.#host(parts.slice(0, depth)));
			if (info === undefined) return undefined;
			if (!info.isDirectory()) throw new MirrorError(`${parts.slice(0, depth).join("/")} is not a directory in the workspace copy`);
		}
		return lstatOrUndefined(this.#host(parts));
	}

	#host(parts: readonly string[]): string {
		return path.join(this.hostRoot, ...parts);
	}
}

/** A workspace-relative path's components; refuses anything that could leave the copy. */
function relativeParts(rel: string): string[] {
	const parts = rel.split("/");
	if (rel === "" || rel.includes("\0") || parts.some(part => part === "" || part === "." || part === "..")) {
		throw new MirrorError(`invalid workspace path from the sandbox: ${JSON.stringify(rel)}`);
	}
	if (parts[0] === ".git") throw new MirrorError(`.git is not mirrored: ${rel}`);
	return parts;
}

function fileFingerprint(info: Stats): string {
	return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${info.mode & 0o7777}`;
}

async function lstatOrUndefined(file: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(file);
	} catch (error) {
		if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined;
		throw error;
	}
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Children before their parents. */
function deepestFirst(a: string, b: string): number {
	return b.split("/").length - a.split("/").length || Buffer.compare(Buffer.from(b), Buffer.from(a));
}
