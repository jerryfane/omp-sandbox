import * as fs from "node:fs/promises";

/**
 * Whether anything (file, directory, symlink) is at `file`, without following
 * a final symlink. Not `Bun.file(...).exists()`, which reports false for a
 * directory and so cannot catch a directory that should not be there.
 */
export async function exists(file: string): Promise<boolean> {
	try {
		await fs.lstat(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
