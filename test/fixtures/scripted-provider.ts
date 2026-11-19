// A command-backed omp provider that plays a fixed script of tool calls, so an
// integration test can drive the installed omp with no model and no spend.
// The script is a JSON array in OMP_SANDBOX_SCRIPT. Each step is one tool
// call ({ "name": "bash", "arguments": { ... } }), or an array of them sent in
// one assistant message: a batch, as a model sends parallel calls. Call ids
// number the calls in script order (call_0, call_1, ...). After the last
// result it answers "SCRIPT-DONE". In string arguments, "{{TAG}}" becomes the
// snapshot tag of the last `[file#TAG]` header in the previous tool result, so
// a script can `edit` what it just read.
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
	const steps: (ScriptedCall | ScriptedCall[])[] = JSON.parse(process.env.OMP_SANDBOX_SCRIPT ?? "[]");
	pi.registerProvider("scripted", {
		baseUrl: "https://scripted.invalid/",
		apiKey: "unused",
		api: "scripted-api",
		streamSimple(model: ScriptedModel, context: ScriptedContext) {
			const stream = new AssistantMessageEventStream();
			const results = context.messages.filter(m => m.role === "toolResult");
			const base = { role: "assistant", api: "scripted-api", provider: "scripted", model: model.id, usage, timestamp: Date.now() };
			queueMicrotask(() => {
				// The next step is the first whose calls have not all been answered.
				let first = 0;
				let index = 0;
				while (index < steps.length && first + callsOf(steps[index]).length <= results.length) {
					first += callsOf(steps[index]).length;
					index++;
				}
				const step = steps[index];
				if (step !== undefined) {
					const tag = lastTag(results.at(-1));
					const calls = callsOf(step).map((call, offset) => ({
						type: "toolCall",
						id: `call_${first + offset}`,
						name: call.name,
						arguments: JSON.parse(JSON.stringify(call.arguments).replaceAll("{{TAG}}", tag ?? "NO-TAG")),
					}));
					const message = { ...base, content: calls, stopReason: "toolUse" };
					stream.push({ type: "start", partial: message });
					for (const [contentIndex, call] of calls.entries()) {
						// Tools such as edit read their input from the streamed arguments, not only the final call.
						stream.push({ type: "toolcall_start", contentIndex, partial: message });
						stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: message });
						stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
					}
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

function callsOf(step: ScriptedCall | ScriptedCall[] | undefined): ScriptedCall[] {
	return step === undefined ? [] : Array.isArray(step) ? step : [step];
}
