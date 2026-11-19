import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Backend, Changes, SyncFile, TreeEntry } from "./backend.ts";

/** A sync could not keep the host copy and the sandbox consistent; the mirror refuses further work. */
export class MirrorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MirrorError";
	}
}

/** A path present on both sides at the last sync. */
interface Known {
	type: "file" | "dir";
	/** The host path's identity then: a file's size, times, inode and mode; a directory's device and inode. */
	host: string;
	/**
	 * A file's content hash and mode at the last sync: what both sides held.
	 * A reported sandbox change is real only when the pulled content or mode
	 * differs; metadata alone (size, mtime) can miss an edit.
	 */
	content?: string;
	/**
	 * Whether a sandbox delete may remove the host path. A file the mirror
	 * synced always may (when unchanged here). A directory may only when the
	 * mirror made it while pulling, or it exists in the sandbox because the
	 * mirror pushed files into it; a directory the mirror merely found here is
	 * never removed.
	 */
	owned: boolean;
}

interface Scanned {
	type: "file" | "dir" | "symlink" | "other";
	fingerprint: string;
}

type Kind = "changed" | "deleted";

/** Files moved per pull or push call, so one call never carries an unbounded batch. */
const BATCH = 256;
const O_CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const O_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** How many conflicting paths a conflict error names. */
const CONFLICTS_SHOWN = 5;

/**
 * A host copy of the sandbox's workspace tree, for omp's own file tools to
 * work on. `pullRemote` brings in what changed in the sandbox; `pushLocal`
 * sends what changed here.
 *
 * Only regular files and directories are mirrored. A sandbox symlink or
 * special file is not created here (a symlink could lead a host tool out of
 * the copy), and `.git` is not mirrored.
 *
 * Conflicts are never resolved: a path changed on both sides since the last
 * sync, or a host path the mirror would have to delete or overwrite without
 * owning it, breaks the mirror. So does any other sync failure. A broken
 * mirror refuses every further sync, so nothing runs against a copy that no
 * longer matches the sandbox.
 *
 * Syncs run one at a time (an internal queue), and the host copy is changed
 * only by the mirror and by the tools between syncs: a scan never sees a
 * transfer in progress.
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

	/**
	 * Send host-side changes (new, modified and deleted files) to the sandbox.
	 * What changed in the sandbox meanwhile is checked first: any overlap is a
	 * conflict and nothing is sent.
	 */
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
		await this.#apply(await this.#remoteDelta(changes));
		this.#token = changes.token;
	}

	async #push(): Promise<void> {
		const scan = await this.#scanHost();
		const local = new Map<string, Kind>();
		for (const [rel, entry] of scan) {
			if (entry.type === "symlink" || entry.type === "other") {
				throw new MirrorError(`${rel} is a ${entry.type} in the workspace copy; only files and directories are synced`);
			}
			if (entry.type === "dir" && this.#known.get(rel)?.type === "file") {
				throw new MirrorError(`${rel} was a synced file and is now a directory in the workspace copy; that change is not synced`);
			}
			if (entry.type === "file" && this.#known.get(rel)?.host !== entry.fingerprint) local.set(rel, "changed");
		}
		for (const rel of this.#known.keys()) if (!scan.has(rel)) local.set(rel, "deleted");
		if (local.size === 0) return;

		// What the sandbox did since the last sync, checked before anything is sent.
		const changes = await this.#backend.changes(this.#token);
		const remote = await this.#remoteDelta(changes);
		const conflicts = overlap(local, remote);
		if (conflicts.length > 0) {
			const shown = conflicts.slice(0, CONFLICTS_SHOWN).join(", ");
			const more = conflicts.length > CONFLICTS_SHOWN ? ` and ${conflicts.length - CONFLICTS_SHOWN} more` : "";
			throw new MirrorError(`changed both in the sandbox and in the workspace copy since the last sync: ${shown}${more}`);
		}
		await this.#apply(remote);
		this.#token = changes.token;

		const changed = [...local].filter(([, kind]) => kind === "changed").map(([rel]) => rel);
		for (let start = 0; start < changed.length; start += BATCH) {
			const batch: SyncFile[] = [];
			const fingerprints: string[] = [];
			for (const rel of changed.slice(start, start + BATCH)) {
				const read = await this.#readHost(rel);
				if (read === undefined) continue; // gone since the scan; the next push sends the delete
				batch.push(read.file);
				fingerprints.push(read.fingerprint);
			}
			await this.#backend.push(batch);
			for (const [index, file] of batch.entries()) {
				this.#known.set(file.path, { type: "file", host: fingerprints[index] as string, content: contentKey(file), owned: true });
				// The sandbox created any missing parents, so a later delete here must reach them
				// there, and a delete there may remove them here (when still empty): the directory
				// exists on both sides because of this push. Its identity is recorded, so a
				// replacement made later is never removed.
				const parts = file.path.split("/");
				for (let depth = 1; depth < parts.length; depth++) {
					const parent = parts.slice(0, depth);
					const rel = parent.join("/");
					if (this.#known.has(rel)) continue;
					const info = await fs.lstat(this.#host(parent));
					this.#known.set(rel, { type: "dir", host: dirFingerprint(info), owned: true });
				}
			}
		}
		// Directories after their contents: deepest first.
		const removed = [...local].filter(([, kind]) => kind === "deleted").map(([rel]) => rel).sort(deepestFirst);
		for (let start = 0; start < removed.length; start += BATCH) {
			const batch = removed.slice(start, start + BATCH);
			await this.#backend.remove(batch);
			for (const rel of batch) this.#known.delete(rel);
		}
		// Move the token past what was just sent, so a later sandbox change to
		// one of these paths (even a delete) is reported. The echo of the push
		// itself has the content just recorded, so it is not a change.
		await this.#pull();
	}

	/**
	 * What really changed in the sandbox since the last sync, as paths. A
	 * reported file the last sync already held is pulled and compared by
	 * content and mode: an edit that kept size and mtime is still found, and a
	 * file reported only because of its metadata, or the echo of a push, is
	 * not a change. A file the mirror does not hold is a change without being
	 * pulled. Contents are hashed one batch at a time and not kept, so memory
	 * stays bounded by BATCH; #apply pulls the changed files again to write
	 * them. Directories count when new or replacing a file; symlinks and
	 * special files always do. A full listing's deletes are what the last sync
	 * held and it no longer lists.
	 */
	async #remoteDelta(changes: Changes): Promise<RemoteDelta> {
		const others: TreeEntry[] = [];
		const files: string[] = [];
		const toCompare: string[] = [];
		for (const entry of changes.changed) {
			if (entry.type === "file") (this.#known.get(entry.path)?.type === "file" ? toCompare : files).push(entry.path);
			else if (entry.type !== "dir" || this.#known.get(entry.path)?.type !== "dir") others.push(entry);
		}
		for (let start = 0; start < toCompare.length; start += BATCH) {
			// A file gone by the time it is pulled is left out; the next `changes` reports it.
			for (const file of await this.#backend.pull(toCompare.slice(start, start + BATCH))) {
				if (this.#known.get(file.path)?.content !== contentKey(file)) files.push(file.path);
			}
		}
		files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
		let deleted = changes.deleted;
		if (changes.full) {
			const listed = new Set(changes.changed.map(entry => entry.path));
			deleted = [...this.#known.keys()].filter(rel => !listed.has(rel));
		}
		return { others, files, deleted };
	}

	async #apply(delta: RemoteDelta): Promise<void> {
		for (const rel of [...delta.deleted].sort(deepestFirst)) await this.#removeHost(rel, "deleted in the sandbox");
		// `changes` lists in byte order, so a directory comes before what is in it.
		for (const entry of delta.others) {
			const parts = relativeParts(entry.path);
			if (entry.type === "dir") await this.#ensureDir(parts);
			// A symlink or special file: not mirrored. A file the mirror held there goes.
			else await this.#removeHost(entry.path, `a ${entry.type} in the sandbox now`);
		}
		for (let start = 0; start < delta.files.length; start += BATCH) {
			// One batch of contents at a time; a file gone since #remoteDelta is left out.
			for (const file of await this.#backend.pull(delta.files.slice(start, start + BATCH))) await this.#writeHost(file);
		}
	}

	/**
	 * Remove a host path the mirror owns because the sandbox no longer has it.
	 * A file changed here since is a conflict. A directory is removed only
	 * when the mirror made it, it is still that directory, and it is empty;
	 * otherwise it stays and the mirror stops tracking it.
	 */
	async #removeHost(rel: string, why: string): Promise<void> {
		const parts = relativeParts(rel);
		const known = this.#known.get(rel);
		if (known === undefined) return; // never synced: not the mirror's to remove
		const target = await this.#lstatInside(parts);
		if (target === undefined) {
			this.#known.delete(rel);
			return;
		}
		if (known.type === "dir") {
			if (!known.owned || !target.isDirectory() || dirFingerprint(target) !== known.host) {
				this.#known.delete(rel);
				return;
			}
			try {
				await fs.rmdir(this.#host(parts));
				this.#known.delete(rel);
			} catch (error) {
				// Files made here and not synced yet: the directory stays, and so does its record.
				if (!isCode(error, "ENOTEMPTY") && !isCode(error, "EEXIST")) throw error;
			}
			return;
		}
		if (target.isFile() && fileFingerprint(target) === known.host) {
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
			let info = await lstatOrUndefined(this.#host(prefix));
			if (info?.isDirectory()) {
				const known = this.#known.get(rel);
				// One the mirror did not make (or a replacement of one it did) is tracked, never owned.
				if (known === undefined || known.type !== "dir" || known.host !== dirFingerprint(info)) {
					this.#known.set(rel, { type: "dir", host: dirFingerprint(info), owned: false });
				}
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
			info = await fs.lstat(this.#host(prefix));
			this.#known.set(rel, { type: "dir", host: dirFingerprint(info), owned: true });
		}
	}

	/** Write a file that changed in the sandbox, unless the host copy holds changes of its own there. */
	async #writeHost(file: SyncFile): Promise<void> {
		const parts = relativeParts(file.path);
		await this.#ensureDir(parts.slice(0, -1));
		const target = this.#host(parts);
		const known = this.#known.get(file.path);
		const info = await lstatOrUndefined(target);
		if (info === undefined) {
			if (known !== undefined) throw new MirrorError(`${file.path} changed in the sandbox, but was deleted in the workspace copy`);
		} else if (info.isDirectory() && known?.type === "dir") {
			// A directory, now a file in the sandbox; its contents were deleted first.
			await this.#removeHost(file.path, "replaced by a file in the sandbox");
			if ((await lstatOrUndefined(target)) !== undefined) {
				throw new MirrorError(`${file.path} is a file in the sandbox but a directory in the workspace copy`);
			}
		} else if (!info.isFile() || known === undefined || fileFingerprint(info) !== known.host) {
			throw new MirrorError(`${file.path} changed in the sandbox and in the workspace copy`);
		}
		const temp = this.#host([...parts.slice(0, -1), `.omp-sandbox-pull-${randomUUID()}`]);
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
		this.#known.set(file.path, { type: "file", host: fileFingerprint(await fs.lstat(target)), content: contentKey(file), owned: true });
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
				if (isGitName(name)) continue;
				const childRel = rel === "" ? name : `${rel}/${name}`;
				const info = await lstatOrUndefined(path.join(dir, name));
				if (info === undefined) continue;
				if (info.isDirectory()) {
					found.set(childRel, { type: "dir", fingerprint: dirFingerprint(info) });
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

interface RemoteDelta {
	/** Directories, symlinks and special files that are new or changed type. */
	others: TreeEntry[];
	/** Files whose content or mode differs from the last sync, or that the mirror does not hold. */
	files: string[];
	deleted: string[];
}

/**
 * Paths changed on both sides: the same path, or one inside the other (a file
 * edited here in a directory the sandbox deleted, and the reverse). A path
 * deleted on both sides is no conflict.
 */
function overlap(local: ReadonlyMap<string, Kind>, remote: RemoteDelta): string[] {
	const remoteKinds = new Map<string, Kind>();
	for (const entry of remote.others) remoteKinds.set(entry.path, "changed");
	for (const rel of remote.files) remoteKinds.set(rel, "changed");
	for (const rel of remote.deleted) remoteKinds.set(rel, "deleted");
	const clash = (a: Kind, b: Kind) => !(a === "deleted" && b === "deleted");
	const found = new Set<string>();
	for (const [rel, kind] of remoteKinds) {
		for (const candidate of [rel, ...ancestors(rel)]) {
			const mine = local.get(candidate);
			if (mine !== undefined && clash(mine, kind)) found.add(candidate === rel ? rel : `${candidate} (and ${rel})`);
		}
	}
	for (const [rel, kind] of local) {
		for (const parent of ancestors(rel)) {
			const theirs = remoteKinds.get(parent);
			if (theirs !== undefined && clash(kind, theirs)) found.add(`${rel} (and ${parent})`);
		}
	}
	return [...found].sort();
}

function ancestors(rel: string): string[] {
	const parts = rel.split("/");
	return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** A workspace-relative path's components; refuses anything that could leave the copy. */
function relativeParts(rel: string): string[] {
	const parts = rel.split("/");
	if (rel === "" || rel.includes("\0") || parts.some(part => part === "" || part === "." || part === "..")) {
		throw new MirrorError(`invalid workspace path from the sandbox: ${JSON.stringify(rel)}`);
	}
	if (parts.some(isGitName)) throw new MirrorError(`.git is not mirrored: ${rel}`);
	return parts;
}

/** `.git` in any letter case: gitmoot never lists, pulls, pushes or removes one, at any depth. */
function isGitName(name: string): boolean {
	return name.toLowerCase() === ".git";
}

function fileFingerprint(info: Stats): string {
	return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${info.mode & 0o7777}`;
}

function dirFingerprint(info: Stats): string {
	return `dir:${info.dev}:${info.ino}`;
}

/** A file's content hash and mode: what makes two versions the same. */
function contentKey(file: SyncFile): string {
	return `${file.mode}:${createHash("sha256").update(file.data).digest("hex")}`;
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
