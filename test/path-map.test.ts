import { describe, expect, test } from "bun:test";
import { OutsideWorkspaceError, PathMap } from "../src/path-map.ts";

const map = new PathMap("/home/seat/work/repo", "/home/user/work");

describe("toSandbox", () => {
	test("maps the root, relative paths and absolute paths inside the workspace", () => {
		expect(map.toSandbox(".")).toBe("/home/user/work");
		expect(map.toSandbox("/home/seat/work/repo/")).toBe("/home/user/work");
		expect(map.toSandbox("src/a.ts")).toBe("/home/user/work/src/a.ts");
		expect(map.toSandbox("/home/seat/work/repo/src/a.ts")).toBe("/home/user/work/src/a.ts");
		expect(map.toSandbox("../b", "/home/seat/work/repo/src")).toBe("/home/user/work/b");
	});

	test("refuses anything that resolves outside the workspace", () => {
		for (const file of ["..", "../other", "/etc/passwd", "/home/seat/work/repo-sibling/x", "src/../../x"]) {
			expect(() => map.toSandbox(file)).toThrow(OutsideWorkspaceError);
		}
		// A base outside the workspace cannot smuggle a path in.
		expect(() => map.toSandbox("x", "/tmp")).toThrow(OutsideWorkspaceError);
	});

	test("names that merely begin with two dots are inside the workspace", () => {
		expect(map.toSandbox("..cache")).toBe("/home/user/work/..cache");
		expect(map.toSandbox("..config/sub")).toBe("/home/user/work/..config/sub");
		expect(map.toSandbox("/home/seat/work/repo/...")).toBe("/home/user/work/...");
	});

	test("a sandbox root of / maps without a doubled slash", () => {
		const rooted = new PathMap("/home/seat/repo", "/");
		expect(rooted.toSandbox("a/b")).toBe("/a/b");
		expect(rooted.toSandbox(".")).toBe("/");
	});
});

describe("toHost", () => {
	test("maps sandbox paths back, and returns null outside the sandbox root", () => {
		expect(map.toHost("/home/user/work")).toBe("/home/seat/work/repo");
		expect(map.toHost("/home/user/work/src/a.ts")).toBe("/home/seat/work/repo/src/a.ts");
		expect(map.toHost("/home/user/workspace/x")).toBeNull();
		expect(map.toHost("/etc")).toBeNull();
	});

	test("sandbox names that begin with two dots map back", () => {
		expect(map.toHost("/home/user/work/..cache")).toBe("/home/seat/work/repo/..cache");
		expect(map.toHost("/home/user/work/..config/sub")).toBe("/home/seat/work/repo/..config/sub");
		expect(map.toHost("/home/user/work/..")).toBeNull();
	});
});
