// A command-backed omp provider that plays a fixed script of tool calls, so an
// integration test can drive the installed omp with no model and no spend.
// The script is a JSON array of tool calls in OMP_SANDBOX_SCRIPT (each item
// { "name": "bash", "arguments": { ... } }); after the last result it answers
// "SCRIPT-DONE". In string arguments, "{{TAG}}" becomes the snapshot tag of the
// last `[file#TAG]` header in the previous tool result, so a script can `edit`
// what it just read.
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

interface ScriptedCall {
	name: string;
	arguments: Record<string, unknown>;
}

interface ScriptedMessage {
	role: string;
	content?: unknown;
}

interface ScriptedContext {
	messages: ScriptedMessage[];
}

interface ScriptedModel {
	id: string;
}

interface ProviderAPI {
	registerProvider(name: string, config: Record<string, unknown>): void;
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export default function scriptedProvider(pi: ProviderAPI): void {
	const script: ScriptedCall[] = JSON.parse(process.env.OMP_SANDBOX_SCRIPT ?? "[]");
	pi.registerProvider("scripted", {
		baseUrl: "https://scripted.invalid/",
		apiKey: "unused",
		api: "scripted-api",
		streamSimple(model: ScriptedModel, context: ScriptedContext) {
			const stream = new AssistantMessageEventStream();
			const done = context.messages.filter(m => m.role === "toolResult").length;
			const base = { role: "assistant", api: "scripted-api", provider: "scripted", model: model.id, usage, timestamp: Date.now() };
			queueMicrotask(() => {
				const step = script[done];
				if (step !== undefined) {
					const tag = lastTag(context.messages.filter(m => m.role === "toolResult").at(-1));
					const args = JSON.parse(JSON.stringify(step.arguments).replaceAll("{{TAG}}", tag ?? "NO-TAG"));
					const call = { type: "toolCall", id: `call_${done}`, name: step.name, arguments: args };
					const message = { ...base, content: [call], stopReason: "toolUse" };
					stream.push({ type: "start", partial: message });
					// Tools such as edit read their input from the streamed arguments, not only the final call.
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = { ...base, content: [{ type: "text", text: "SCRIPT-DONE" }], stopReason: "stop" };
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				}
				stream.end();
			});
			return stream;
		},
		models: [
			{
				id: "scripted-1",
				name: "Scripted",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16000,
			},
		],
	});
}

function lastTag(message: ScriptedMessage | undefined): string | undefined {
	const parts = Array.isArray(message?.content) ? (message.content as { text?: string }[]) : [];
	const text = parts.map(part => part.text ?? "").join("");
	return [...text.matchAll(/\[[^\]\n]*#([0-9A-Z]{4})\]/g)].at(-1)?.[1];
}
