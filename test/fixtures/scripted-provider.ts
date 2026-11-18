// A command-backed omp provider that plays a fixed script of tool calls, so an
// integration test can drive the installed omp with no model and no spend.
// The script is a JSON array of tool calls in OMP_SANDBOX_SCRIPT (each item
// { "name": "bash", "arguments": { ... } }); after the last result it answers
// "SCRIPT-DONE".
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

interface ScriptedCall {
	name: string;
	arguments: Record<string, unknown>;
}

interface ScriptedMessage {
	role: string;
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
					const call = { type: "toolCall", id: `call_${done}`, name: step.name, arguments: step.arguments };
					const message = { ...base, content: [call], stopReason: "toolUse" };
					stream.push({ type: "start", partial: message });
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
