import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Backend, Changes } from "../src/backend.ts";
import { LocalBackend } from "../src/local-backend.ts";
import { Mirror, MirrorError } from "../src/mirror.ts";

let scratch: string;
let sandbox: string;
let host: string;
let backend: LocalBackend;

beforeEach(async () => {
	scratch = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-mirror-"));
	sandbox = path.join(scratch, "sandbox");
	host = path.join(scratch, "host");
	await fs.mkdir(sandbox);
	await fs.mkdir(host);
	backend = await LocalBackend.create(sandbox, { containment: "process-tree" });
});

afterEach(async () => {
	await backend.close();
	await fs.rm(scratch, { recursive: true, force: true });
});

async function put(root: string, rel: string, content: string, mode?: number): Promise<void> {
	await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
	await fs.writeFile(path.join(root, rel), content);
	if (mode !== undefined) await fs.chmod(path.join(root, rel), mode);
}

async function tree(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, rel: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				out.push(`${childRel}/`);
				await walk(path.join(dir, entry.name), childRel);
			} else if (entry.isSymbolicLink()) out.push(`${childRel}@`);
			else out.push(`${childRel}=${await fs.readFile(path.join(dir, entry.name), "utf8")}`);
		}
	};
	await walk(root, "");
	return out.sort();
}

/** mtimes are compared at a resolution the filesystem may round; a later write must look different. */
async function tick(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 20));
}

/** A Backend that forwards to the LocalBackend under test, with some methods replaced. */
function delegating(overrides: Partial<Backend>): Backend {
	return {
		name: backend.name,
		root: backend.root,
		containment: backend.containment,
		exec: (command, options) => backend.exec(command, options),
		shellCommand: (command, options) => backend.shellCommand(command, options),
		readFile: file => backend.readFile(file),
		writeFile: (file, data, options) => backend.writeFile(file, data, options),
		stat: file => backend.stat(file),
		list: (dir, options) => backend.list(dir, options),
		changes: since => backend.changes(since),
		pull: paths => backend.pull(paths),
		push: files => backend.push(files),
		remove: paths => backend.remove(paths),
		close: () => backend.close(),
		...overrides,
	};
}

describe("Mirror", () => {
	test("the first pull copies files, directories and modes; never symlinks, special files or .git", async () => {
		await put(sandbox, "a.txt", "A");
		await put(sandbox, "bin/run.sh", "#!/bin/sh\n", 0o755);
		await put(sandbox, ".git/HEAD", "ref");
		await fs.mkdir(path.join(sandbox, "empty"));
		await fs.symlink("/etc/passwd", path.join(sandbox, "link"));
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		expect(await tree(host)).toEqual(["a.txt=A", "bin/", "bin/run.sh=#!/bin/sh\n", "empty/"]);
		expect((await fs.stat(path.join(host, "bin/run.sh"))).mode & 0o777).toBe(0o755);
	});

	test("no .git at any depth crosses in either direction", async () => {
		await put(sandbox, "lib/.git/HEAD", "ref");
		await put(sandbox, "lib/x.txt", "x");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		expect(await tree(host)).toEqual(["lib/", "lib/x.txt=x"]);
		await tick();
		await put(host, "lib/.git/config", "host-made");
		await put(host, "sub/.git", "gitdir: elsewhere\n");
		await put(host, "up/.GIT/config", "case");
		await mirror.pushLocal();
		expect(await fs.readFile(path.join(sandbox, "lib/.git/HEAD"), "utf8")).toBe("ref");
		expect(await Bun.file(path.join(sandbox, "lib/.git/config")).exists()).toBe(false);
		expect(await Bun.file(path.join(sandbox, "sub/.git")).exists()).toBe(false);
		expect(await Bun.file(path.join(sandbox, "up/.GIT/config")).exists()).toBe(false);
		// The copy stays usable: an ordinary edit still syncs.
		await put(host, "lib/x.txt", "x2");
		await mirror.pushLocal();
		expect(await fs.readFile(path.join(sandbox, "lib/x.txt"), "utf8")).toBe("x2");
	});

	test("refuses to start on a host directory that is not empty", async () => {
		await put(host, "stray.txt", "x");
		await expect(Mirror.create(backend, host)).rejects.toThrow(MirrorError);
	});

	test("local creates, edits, mode changes and deletes reach the sandbox; emptied directories go too", async () => {
		await put(sandbox, "keep.txt", "k");
		await put(sandbox, "old/gone.txt", "g");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();

		await tick();
		await put(host, "keep.txt", "k2");
		await fs.chmod(path.join(host, "keep.txt"), 0o700);
		await put(host, "new/deep/n.txt", "n");
		await fs.rm(path.join(host, "old"), { recursive: true });
		await mirror.pushLocal();
		expect(await tree(sandbox)).toEqual(["keep.txt=k2", "new/", "new/deep/", "new/deep/n.txt=n"]);
		expect((await fs.stat(path.join(sandbox, "keep.txt"))).mode & 0o777).toBe(0o700);

		// The pushed state comes back as a no-op, and a later delete of a directory created by a push is sent.
		await mirror.pullRemote();
		expect(await tree(host)).toEqual(["keep.txt=k2", "new/", "new/deep/", "new/deep/n.txt=n"]);
		await fs.rm(path.join(host, "new"), { recursive: true });
		await mirror.pushLocal();
		expect(await tree(sandbox)).toEqual(["keep.txt=k2"]);
	});

	test("sandbox edits, deletes and type changes reach the host copy", async () => {
		await put(sandbox, "f.txt", "1");
		await put(sandbox, "d/inner.txt", "i");
		await put(sandbox, "becomes-dir", "file");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();

		await tick();
		await put(sandbox, "f.txt", "2");
		await fs.rm(path.join(sandbox, "d"), { recursive: true });
		await put(sandbox, "d", "now a file");
		await fs.rm(path.join(sandbox, "becomes-dir"));
		await put(sandbox, "becomes-dir/x.txt", "x");
		await mirror.pullRemote();
		expect(await tree(host)).toEqual(["becomes-dir/", "becomes-dir/x.txt=x", "d=now a file", "f.txt=2"]);
	});

	test("a file pushed and then deleted in the sandbox disappears from the copy", async () => {
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await put(host, "brief.txt", "pushed");
		await mirror.pushLocal();
		expect(await tree(sandbox)).toEqual(["brief.txt=pushed"]);
		await fs.rm(path.join(sandbox, "brief.txt"));
		await mirror.pullRemote();
		expect(await tree(host)).toEqual([]);
	});

	test("a file that became a symlink in the sandbox is removed from the copy, not followed", async () => {
		await put(sandbox, "s.txt", "s");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await fs.rm(path.join(sandbox, "s.txt"));
		await fs.symlink("/etc/passwd", path.join(sandbox, "s.txt"));
		await mirror.pullRemote();
		expect(await tree(host)).toEqual([]);
	});

	test("a file changed on both sides is a conflict: the mirror stops and refuses every later sync", async () => {
		await put(sandbox, "c.txt", "base");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await tick();
		await put(sandbox, "c.txt", "sandbox");
		await put(host, "c.txt", "host");
		await expect(mirror.pullRemote()).rejects.toThrow(/changed in the sandbox and in the workspace copy/);
		expect(mirror.broken).toBeDefined();
		await expect(mirror.pushLocal()).rejects.toThrow(MirrorError);
		// Neither side was overwritten.
		expect(await fs.readFile(path.join(sandbox, "c.txt"), "utf8")).toBe("sandbox");
		expect(await fs.readFile(path.join(host, "c.txt"), "utf8")).toBe("host");
	});

	/** Rewrite a sandbox file keeping its size and its exact mtime (a whole second, so nothing is rounded). */
	async function editKeepingMtime(rel: string, content: string): Promise<void> {
		await put(sandbox, rel, content);
		await fs.utimes(path.join(sandbox, rel), 1_000_000_000, 1_000_000_000);
	}

	test("a sandbox edit that keeps the size and mtime still reaches the copy", async () => {
		await editKeepingMtime("s.txt", "aaaa");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await editKeepingMtime("s.txt", "bbbb");
		await mirror.pullRemote();
		expect(await fs.readFile(path.join(host, "s.txt"), "utf8")).toBe("bbbb");
	});

	test("a push is refused when the sandbox edited the same file keeping its size and mtime", async () => {
		await editKeepingMtime("s.txt", "aaaa");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await editKeepingMtime("s.txt", "bbbb");
		await tick();
		await put(host, "s.txt", "host");
		await expect(mirror.pushLocal()).rejects.toThrow(/s\.txt/);
		expect(await fs.readFile(path.join(sandbox, "s.txt"), "utf8")).toBe("bbbb");
	});

	test("a sandbox file touched without a change is not a conflict for a local edit elsewhere or to it", async () => {
		await put(sandbox, "t.txt", "same");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await tick();
		await fs.utimes(path.join(sandbox, "t.txt"), new Date(), new Date());
		await put(host, "t.txt", "host edit");
		await mirror.pushLocal();
		expect(await fs.readFile(path.join(sandbox, "t.txt"), "utf8")).toBe("host edit");
	});

	test("a push checks the sandbox first: a file changed on both sides is not overwritten there", async () => {
		await put(sandbox, "c.txt", "base");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await tick();
		// A background job changes the file in the sandbox after the pull; a tool edits the copy.
		await put(sandbox, "c.txt", "sandbox");
		await put(host, "c.txt", "host");
		await expect(mirror.pushLocal()).rejects.toThrow(/changed both in the sandbox and in the workspace copy.*c\.txt/);
		expect(await fs.readFile(path.join(sandbox, "c.txt"), "utf8")).toBe("sandbox");
		expect(await fs.readFile(path.join(host, "c.txt"), "utf8")).toBe("host");
		expect(mirror.broken).toBeDefined();
	});

	test("a push conflicts with a sandbox change to a directory around a file changed here", async () => {
		await put(sandbox, "d/f.txt", "base");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await tick();
		await fs.rm(path.join(sandbox, "d"), { recursive: true });
		await put(host, "d/f.txt", "host");
		await expect(mirror.pushLocal()).rejects.toThrow(/d\/f\.txt/);
		expect(await tree(sandbox)).toEqual([]);
	});

	test("a push sends a file while the sandbox changed a different one, and brings that one in", async () => {
		await put(sandbox, "mine.txt", "1");
		await put(sandbox, "theirs.txt", "1");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await tick();
		await put(sandbox, "theirs.txt", "2");
		await put(host, "mine.txt", "2");
		await mirror.pushLocal();
		expect(await tree(sandbox)).toEqual(["mine.txt=2", "theirs.txt=2"]);
		expect(await tree(host)).toEqual(["mine.txt=2", "theirs.txt=2"]);
	});

	test("workspace files whose names look like the mirror's temp files are synced like any other", async () => {
		await put(sandbox, ".omp-sandbox-notes.txt", "keep me");
		await put(sandbox, "d/.omp-sandbox-pull-x", "and me");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		expect(await tree(host)).toEqual([".omp-sandbox-notes.txt=keep me", "d/", "d/.omp-sandbox-pull-x=and me"]);
		await mirror.pushLocal();
		expect(await tree(sandbox)).toEqual([".omp-sandbox-notes.txt=keep me", "d/", "d/.omp-sandbox-pull-x=and me"]);
	});

	test("a sandbox delete never removes a host directory the mirror found rather than made", async () => {
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		// Made here by a tool and, before any push, also made in the sandbox.
		await fs.mkdir(path.join(host, "found"));
		await put(sandbox, "found/remote.txt", "r");
		await mirror.pullRemote();
		await fs.rm(path.join(sandbox, "found"), { recursive: true });
		await mirror.pullRemote();
		expect(await tree(host)).toEqual(["found/"]);
	});

	test("a sandbox delete never removes a host directory replaced since the last sync", async () => {
		await put(sandbox, "d/a.txt", "a");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		// The mirror's d is replaced by another directory of the same name. The new
		// one is made while the old still exists, so it cannot reuse its inode.
		await fs.rename(path.join(host, "d"), path.join(host, "old-d"));
		await fs.mkdir(path.join(host, "d"));
		await fs.rm(path.join(host, "old-d"), { recursive: true });
		await fs.rm(path.join(sandbox, "d"), { recursive: true });
		await mirror.pullRemote();
		expect(await tree(host)).toEqual(["d/"]);
	});

	test("a directory made here only to hold a pushed file is removed here when the sandbox deletes it", async () => {
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await put(host, "made/f.txt", "f");
		await mirror.pushLocal();
		await fs.rm(path.join(sandbox, "made"), { recursive: true });
		await mirror.pullRemote();
		expect(await tree(host)).toEqual([]);
	});

	test("a sandbox delete of a file edited in the copy is a conflict, and the edit survives", async () => {
		await put(sandbox, "e.txt", "base");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await tick();
		await put(host, "e.txt", "edited");
		await fs.rm(path.join(sandbox, "e.txt"));
		await expect(mirror.pullRemote()).rejects.toThrow(MirrorError);
		expect(await fs.readFile(path.join(host, "e.txt"), "utf8")).toBe("edited");
	});

	test("a sandbox delete never removes a host file the mirror did not write", async () => {
		await put(sandbox, "dir/a.txt", "a");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await put(host, "dir/unsynced.txt", "mine");
		await fs.rm(path.join(sandbox, "dir"), { recursive: true });
		await mirror.pullRemote();
		// dir stays because it holds a file not synced yet; that file is untouched.
		expect(await tree(host)).toEqual(["dir/", "dir/unsynced.txt=mine"]);
	});

	test("a symlink created in the copy is refused, not pushed", async () => {
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		await fs.symlink("/etc/passwd", path.join(host, "l"));
		await expect(mirror.pushLocal()).rejects.toThrow(/symlink/);
		expect(await tree(sandbox)).toEqual([]);
	});

	test("an unknown token means a full listing: deletes are found by comparing with what the copy holds", async () => {
		await put(sandbox, "x.txt", "x");
		await put(sandbox, "y.txt", "y");
		// A backend that forgets every token, like one that restarted.
		const forgetful = delegating({ changes: (): Promise<Changes> => backend.changes(undefined) });
		const mirror = await Mirror.create(forgetful, host);
		await mirror.pullRemote();
		await fs.rm(path.join(sandbox, "x.txt"));
		await mirror.pullRemote();
		expect(await tree(host)).toEqual(["y.txt=y"]);
	});

	test("a large fill writes each batch before pulling the next, so contents in memory stay bounded", async () => {
		for (let i = 0; i < 600; i++) await put(sandbox, `many/f${String(i).padStart(4, "0")}.txt`, `content ${i}`);
		const hostFilesAtPull: number[] = [];
		const counting = delegating({
			pull: async paths => {
				hostFilesAtPull.push((await fs.readdir(path.join(host, "many")).catch(() => [])).length);
				return backend.pull(paths);
			},
		});
		const mirror = await Mirror.create(counting, host);
		await mirror.pullRemote();
		expect((await fs.readdir(path.join(host, "many"))).length).toBe(600);
		// Three batches of at most 256: the later pulls start after earlier files were written.
		expect(hostFilesAtPull.length).toBeGreaterThanOrEqual(3);
		expect(hostFilesAtPull[0]).toBe(0);
		expect(hostFilesAtPull.at(-1)).toBeGreaterThan(0);
		// 600 files on a shared host: well past bun's 5 s default under load.
	}, 60_000);
});

describe("Mirror and ignored build output", () => {
	function git(...args: string[]): void {
		const run = Bun.spawnSync(["git", "-C", sandbox, ...args], { stdout: "ignore", stderr: "pipe" });
		if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
	}

	test("ignored node_modules and .cache stay out of the copy at any depth; a tracked or unignored one is mirrored", async () => {
		git("init", "-q");
		await put(sandbox, ".gitignore", "node_modules/\n.cache/\n");
		await put(sandbox, "src/a.ts", "a");
		await put(sandbox, "node_modules/dep/index.js", "dep");
		await put(sandbox, "pkg/node_modules/inner/x.js", "x");
		await put(sandbox, ".cache/blob", "c");
		await put(sandbox, "target/out.txt", "not ignored");
		await put(sandbox, "vendored/node_modules/kept.js", "tracked");
		git("add", "-f", "vendored/node_modules/kept.js");
		let execs = 0;
		const counting = delegating({ exec: (command, options) => (execs++, backend.exec(command, options)) });
		const mirror = await Mirror.create(counting, host);
		await mirror.pullRemote();
		expect(await tree(host)).toEqual([".gitignore=node_modules/\n.cache/\n", "pkg/", "src/", "src/a.ts=a", "target/", "target/out.txt=not ignored", "vendored/", "vendored/node_modules/", "vendored/node_modules/kept.js=tracked"]);
		expect(execs).toBe(1);
		expect(mirror.excludes("node_modules")).toBe(true);
		expect(mirror.excludes("pkg/node_modules/inner/x.js")).toBe(true);
		expect(mirror.excludes("vendored/node_modules/kept.js")).toBe(false);
		expect(mirror.excludes("src/a.ts")).toBe(false);

		// Build output changing in the sandbox costs no further git call, and never reaches the copy.
		await tick();
		await put(sandbox, "node_modules/dep/index.js", "dep v2");
		await put(sandbox, "node_modules/new/y.js", "y");
		await mirror.pullRemote();
		expect(execs).toBe(1);
		expect(await Bun.file(path.join(host, "node_modules")).exists()).toBe(false);

		// A host edit is sent, and the sandbox's build output is left alone.
		await put(host, "src/a.ts", "a2");
		await mirror.pushLocal();
		expect(await fs.readFile(path.join(sandbox, "src/a.ts"), "utf8")).toBe("a2");
		expect(await fs.readFile(path.join(sandbox, "node_modules/dep/index.js"), "utf8")).toBe("dep v2");
		expect(await fs.readFile(path.join(sandbox, ".cache/blob"), "utf8")).toBe("c");
	}, 60_000);

	test("a .gitignore change moves a build directory out of the copy, and back in when it is no longer ignored", async () => {
		git("init", "-q");
		await put(sandbox, "src/main.rs", "fn main() {}");
		await put(sandbox, "target/debug/app", "binary");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		expect(await fs.readFile(path.join(host, "target/debug/app"), "utf8")).toBe("binary");

		await put(sandbox, ".gitignore", "target/\n");
		await mirror.pullRemote();
		expect(await Bun.file(path.join(host, "target")).exists()).toBe(false);
		expect(mirror.excludes("target/debug/app")).toBe(true);
		// Not a host delete: the sandbox keeps it.
		await put(host, "src/main.rs", "fn main() { }");
		await mirror.pushLocal();
		expect(await fs.readFile(path.join(sandbox, "target/debug/app"), "utf8")).toBe("binary");

		await fs.rm(path.join(sandbox, ".gitignore"));
		await mirror.pullRemote();
		expect(await fs.readFile(path.join(host, "target/debug/app"), "utf8")).toBe("binary");
		expect(mirror.excludes("target")).toBe(false);
	}, 60_000);

	test("outside a git work tree nothing is excluded", async () => {
		await put(sandbox, "node_modules/dep/index.js", "dep");
		const mirror = await Mirror.create(backend, host);
		await mirror.pullRemote();
		expect(await fs.readFile(path.join(host, "node_modules/dep/index.js"), "utf8")).toBe("dep");
		expect(mirror.excludes("node_modules")).toBe(false);
	}, 60_000);
});
