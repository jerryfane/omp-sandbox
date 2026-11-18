// Prints LocalBackend.list(root, {recursive: true}) as JSON, or the error code.
// Run as its own process so a test can run it as an unprivileged user: root
// ignores directory permissions, so a permission error only shows up there.
import { BackendError } from "../../src/backend.ts";
import { LocalBackend } from "../../src/local-backend.ts";

const root = process.argv[2];
if (root === undefined) throw new Error("usage: list-recursive.ts <root>");
const backend = await LocalBackend.create(root, { containment: "process-tree" });
try {
	const listed = await backend.list(backend.root, { recursive: true });
	const entries = listed.entries.map(entry => entry.path.slice(backend.root.length));
	console.log(JSON.stringify({ entries, truncated: listed.truncated }));
} catch (error) {
	console.log(JSON.stringify({ error: error instanceof BackendError ? error.code : String(error) }));
} finally {
	await backend.close();
}
