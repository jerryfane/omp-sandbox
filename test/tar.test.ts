// src/tar.ts against the system's GNU tar, in both directions.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readTar, type TarEntry, writeTar } from "../src/tar.ts";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sandbox-tar-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const bytes = (s: string) => new TextEncoder().encode(s);
const long = `${"deep/".repeat(30)}name with spaces and é.txt`;

const sample: TarEntry[] = [
	{ type: "dir", path: "d", mode: 0o750 },
	{ type: "file", path: "d/run.sh", mode: 0o755, data: bytes("#!/bin/sh\necho hi\n") },
	{ type: "file", path: "empty", mode: 0o600, data: new Uint8Array() },
	{ type: "file", path: "big.bin", mode: 0o644, data: new Uint8Array(1300).map((_, i) => i % 251) },
	{ type: "symlink", path: "d/link", mode: 0o777, target: "../empty" },
	{ type: "file", path: long, mode: 0o644, data: bytes("long name\n") },
	{ type: "symlink", path: "longlink", mode: 0o777, target: `../${"t".repeat(150)}` },
];

async function gnuTar(args: string[], stdin?: Uint8Array): Promise<Uint8Array> {
	const child = Bun.spawn(["/usr/bin/tar", ...args], { cwd: dir, stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`tar ${args.join(" ")}: ${err}`);
	return new Uint8Array(out);
}

test("GNU tar extracts what writeTar writes: contents, modes, symlinks, long names", async () => {
	await gnuTar(["-xf", "-", "--no-same-owner"], writeTar(sample));
	expect((await fs.stat(path.join(dir, "d"))).mode & 0o7777).toBe(0o750);
	expect(await fs.readFile(path.join(dir, "d/run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
	expect((await fs.stat(path.join(dir, "d/run.sh"))).mode & 0o7777).toBe(0o755);
	expect((await fs.readFile(path.join(dir, "big.bin"))).equals(Buffer.from((sample[3] as { data: Uint8Array }).data))).toBe(true);
	expect(await fs.readlink(path.join(dir, "d/link"))).toBe("../empty");
	expect(await fs.readFile(path.join(dir, long), "utf8")).toBe("long name\n");
	expect(await fs.readlink(path.join(dir, "longlink"))).toBe(`../${"t".repeat(150)}`);
});

test("readTar reads GNU tar's pax output back exactly", async () => {
	await gnuTar(["-xf", "-", "--no-same-owner"], writeTar(sample));
	const names = ["d", "d/run.sh", "empty", "big.bin", "d/link", long, "longlink"];
	const stream = await gnuTar(["--format=pax", "--no-recursion", "-cf", "-", ...names]);
	const read = readTar(stream);
	expect(read.map(e => [e.type, e.path, e.mode])).toEqual(sample.map(e => [e.type, e.path, e.mode]));
	expect(read).toEqual(sample);
});

test("an entry type outside files, directories and symlinks is refused", async () => {
	await fs.writeFile(path.join(dir, "a"), "x");
	await fs.link(path.join(dir, "a"), path.join(dir, "hard"));
	const stream = await gnuTar(["--format=pax", "-cf", "-", "a", "hard"]);
	expect(() => readTar(stream)).toThrow(/unsupported entry type/);
});
