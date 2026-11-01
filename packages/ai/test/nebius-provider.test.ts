import { describe, expect, test } from "bun:test";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

async function reasoningRequest(id: string, options: OpenAICompletionsOptions): Promise<Record<string, unknown>> {
	const model = buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "nebius",
		baseUrl: "https://api.tokenfactory.nebius.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 8192,
	});
	let body: Record<string, unknown> | undefined;
	const result = await streamOpenAICompletions(
		model,
		{ messages: [{ role: "user", content: "Probe", timestamp: 0 }] },
		{
			...options,
			apiKey: "nebius-test-key",
			fetch: async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return new Response(
					'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		},
	).result();
	expect(result.stopReason).toBe("stop");
	if (!body) throw new Error("No chat request captured");
	return body;
}

describe("Nebius Token Factory reasoning requests", () => {
	test.each(["deepseek-ai/DeepSeek-V4-Flash-0731", "nvidia/Nemotron-3_5-Lightning", "moonshotai/Kimi-K3"])(
		"disables %s with none rather than its lowest enabled effort",
		async id => {
			expect(await reasoningRequest(id, { disableReasoning: true })).toMatchObject({ reasoning_effort: "none" });
		},
	);

	test("preserves Kimi K3's hosted medium effort instead of remapping it to high", async () => {
		expect(await reasoningRequest("moonshotai/Kimi-K3", { reasoning: Effort.Medium })).toMatchObject({
			reasoning_effort: "medium",
		});
	});

	test("sends Qwen effort and off through the hosted OpenAI dialect, not local template toggles", async () => {
		for (const options of [{ reasoning: Effort.XHigh }, { disableReasoning: true }]) {
			const body = await reasoningRequest("Qwen/Qwen3.8-27B", options);
			expect(body.reasoning_effort).toBe("reasoning" in options ? "xhigh" : "none");
			expect(body.enable_thinking).toBeUndefined();
			expect(body.chat_template_kwargs).toBeUndefined();
		}
	});
});
