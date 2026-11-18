import * as path from "node:path";

/** A host path the agent named lies outside the workspace that maps to the sandbox. */
export class OutsideWorkspaceError extends Error {
	readonly path: string;

	constructor(file: string, hostRoot: string) {
		super(`${file} is outside the sandboxed workspace ${hostRoot}; only paths inside it exist in the sandbox`);
		this.name = "OutsideWorkspaceError";
		this.path = file;
	}
}

/**
 * Maps the agent's view of the workspace (a host directory, the session's
 * workspace root) onto the sandbox root, and back.
 *
 * The mapping is purely lexical: it never looks at the host filesystem, since
 * the files live in the sandbox, not here. A path outside the workspace is
 * refused rather than passed through, so nothing the agent names can quietly
 * refer to the host.
 */
export class PathMap {
	readonly hostRoot: string;
	readonly sandboxRoot: string;

	constructor(hostRoot: string, sandboxRoot: string) {
		if (!path.isAbsolute(hostRoot) || !path.posix.isAbsolute(sandboxRoot)) {
			throw new Error("PathMap roots must be absolute");
		}
		this.hostRoot = trimSlash(path.resolve(hostRoot));
		this.sandboxRoot = trimSlash(path.posix.normalize(sandboxRoot));
	}

	/**
	 * The sandbox path for `file`, a host path absolute or relative to `base`
	 * (itself a host path inside the workspace). Throws OutsideWorkspaceError
	 * when it resolves outside the workspace.
	 */
	toSandbox(file: string, base: string = this.hostRoot): string {
		const resolved = trimSlash(path.resolve(base, file));
		const relative = path.relative(this.hostRoot, resolved);
		if (relative === "") return this.sandboxRoot;
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new OutsideWorkspaceError(file, this.hostRoot);
		}
		return path.posix.join(this.sandboxRoot, ...relative.split(path.sep));
	}

	/** The host path for a sandbox path inside the sandbox root; null outside it. */
	toHost(sandboxPath: string): string | null {
		const normalized = trimSlash(path.posix.normalize(sandboxPath));
		const relative = path.posix.relative(this.sandboxRoot, normalized);
		if (relative === "") return this.hostRoot;
		if (relative.startsWith("..") || path.posix.isAbsolute(relative)) return null;
		return path.join(this.hostRoot, ...relative.split("/"));
	}
}

function trimSlash(file: string): string {
	return file.length > 1 && file.endsWith("/") ? file.slice(0, -1) : file;
}
