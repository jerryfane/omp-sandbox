// Drives omp in RPC mode for a test: sends one prompt, answers each approval
// prompt (an extension_ui_request `select`) with Approve when its title
// contains "approve-" and Deny otherwise, and prints one JSON line per prompt
// ({ "prompt": title }) and per finished tool ({ "end": id, "isError": … }).
// Usage: bun rpc-approver.ts <omp> <cwd> [omp args...]
interface UiRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	title?: string;
	options?: string[];
}

interface ToolEnd {
	type: "tool_execution_end";
	toolCallId: string;
	isError?: boolean;
}

const [omp, cwd, ...ompArgs] = process.argv.slice(2);
if (omp === undefined || cwd === undefined) throw new Error("usage: rpc-approver.ts <omp> <cwd> [omp args...]");
const child = Bun.spawn([omp, "--mode", "rpc", ...ompArgs], { cwd, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const send = (frame: Record<string, unknown>): void => {
	child.stdin.write(`${JSON.stringify(frame)}\n`);
	child.stdin.flush();
};
const timer = setTimeout(() => child.kill(), 90_000);
const decoder = new TextDecoder();
let buffer = "";
let prompted = false;
for await (const chunk of child.stdout) {
	buffer += decoder.decode(chunk, { stream: true });
	for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		let frame: { type?: unknown };
		try {
			frame = JSON.parse(line);
		} catch {
			continue;
		}
		if (frame.type === "ready" && !prompted) {
			prompted = true;
			send({ id: "prompt-1", type: "prompt", message: "go" });
		} else if (frame.type === "extension_ui_request") {
			const request = frame as UiRequest;
			if (request.method !== "select") {
				send({ type: "extension_ui_response", id: request.id, cancelled: true });
				continue;
			}
			const title = request.title ?? "";
			const options = request.options ?? [];
			const answer = title.includes("approve-") ? options.find(o => o === "Approve") : options.find(o => o === "Deny");
			console.log(JSON.stringify({ prompt: title }));
			send({ type: "extension_ui_response", id: request.id, value: answer ?? options.at(-1) });
		} else if (frame.type === "tool_execution_end") {
			const end = frame as ToolEnd;
			console.log(JSON.stringify({ end: end.toolCallId, isError: end.isError === true }));
		} else if (frame.type === "agent_end") {
			clearTimeout(timer);
			child.stdin.end();
		}
	}
}
await child.exited;

export {};
