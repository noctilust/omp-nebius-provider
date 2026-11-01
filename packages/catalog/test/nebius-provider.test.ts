import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { nebiusModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mergePreviousSnapshotModels } from "../scripts/generate-models";

const BASE_URL = "https://api.tokenfactory.nebius.com/v1";

function staticModel(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "nebius",
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 8192,
	};
}

describe("Nebius Token Factory discovery", () => {
	test("discovers new chat models with deployment limits, per-million prices and image input", async () => {
		const options = nebiusModelManagerOptions({
			apiKey: "nebius-test-key",
			fetch: async (input, init) => {
				expect(String(input)).toBe(`${BASE_URL}/models?verbose=true`);
				expect(init?.method).toBe("GET");
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer nebius-test-key");
				return Response.json({
					data: [
						{
							id: "new-chat",
							name: "New Chat",
							context_length: "65536",
							architecture: { modality: "text+image->text" },
							pricing: { prompt: "0.00000125", completion: "0.0000025", input_cache_read: "0.000000125" },
						},
						{ id: "clip-image", architecture: { modality: "text->image" } },
						{ id: "Qwen/Qwen3-Embedding-8B" },
					],
				});
			},
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["new-chat"]);
		expect(models?.[0]).toMatchObject({
			input: ["text", "image"],
			contextWindow: 65536,
			// The listing reports no output-specific budget.
			maxTokens: null,
			cost: { input: 1.25, output: 2.5, cacheRead: 0.125, cacheWrite: 0 },
		});
	});

	test("trims whitespace around modality separators", async () => {
		const options = nebiusModelManagerOptions({
			apiKey: "nebius-test-key",
			fetch: async () =>
				Response.json({
					data: [{ id: "spaced-modality", architecture: { modality: " text + image -> text " } }],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.[0]?.input).toEqual(["text", "image"]);
	});

	test("hides uncatalogued deployments when discovery is limited to catalogued ids", async () => {
		const roster = {
			data: [
				{ id: "deepseek-ai/DeepSeek-V4-Flash-0731", architecture: { modality: "text->text" } },
				{
					id: "dedicated/sa-example/MiniMax-M3.1-Flash-NVFP4-TP2-abc123",
					architecture: { modality: "text->text" },
				},
				{ id: "sa-example/DeepSeek-V4.1-Flash-Coding-Optimized-abc123", architecture: { modality: "text->text" } },
			],
		};
		const fetch: FetchImpl = async () => Response.json(roster);
		const defaults = await nebiusModelManagerOptions({ apiKey: "nebius-test-key", fetch }).fetchDynamicModels?.();
		expect(defaults?.map(model => model.id)).toEqual([
			"dedicated/sa-example/MiniMax-M3.1-Flash-NVFP4-TP2-abc123",
			"deepseek-ai/DeepSeek-V4-Flash-0731",
			"sa-example/DeepSeek-V4.1-Flash-Coding-Optimized-abc123",
		]);

		const catalogued = await nebiusModelManagerOptions({
			apiKey: "nebius-test-key",
			fetch,
			includeUncataloguedModels: false,
		}).fetchDynamicModels?.();
		expect(catalogued?.map(model => model.id)).toEqual(["deepseek-ai/DeepSeek-V4-Flash-0731"]);
	});

	test("waits for credentials, then prunes stale models and image support without regrowing them on failure", async () => {
		await using temp = await TempDir.create("@nebius-discovery-");
		let requests = 0;
		let unavailable = false;
		const fetch: FetchImpl = async () => {
			requests++;
			return unavailable
				? new Response(null, { status: 503 })
				: Response.json({
						data: [
							{
								id: "current",
								context_length: 65536,
								architecture: { modality: "text->text" },
								pricing: { prompt: "0.0000025", completion: "0.00001" },
							},
						],
					});
		};
		const options = {
			...nebiusModelManagerOptions({ fetch }),
			staticModels: [staticModel("current"), staticModel("retired")],
			cacheDbPath: temp.join("models.db"),
		};
		const beforeLogin = await resolveProviderModels(options, "online");
		expect(requests).toBe(0);
		expect(beforeLogin.models.map(model => model.id)).toEqual(["current", "retired"]);

		const authenticated = { ...options, ...nebiusModelManagerOptions({ apiKey: "nebius-test-key", fetch }) };
		const live = await resolveProviderModels(authenticated, "online");
		expect(live.models.map(model => model.id)).toEqual(["current"]);
		expect(live.models[0]).toMatchObject({
			input: ["text"],
			contextWindow: 65536,
			maxTokens: 8192,
			cost: { input: 2.5, output: 10, cacheRead: 0.1 },
		});

		unavailable = true;
		const fallback = await resolveProviderModels(authenticated, "online");
		expect(fallback.source).toBe("cache");
		expect(fallback.models.map(model => model.id)).toEqual(["current"]);
		expect(fallback.models[0].input).toEqual(["text"]);
	});

	test("does not preserve credential-scoped deployments in a regenerated bundle", () => {
		const id = "dedicated/team/private-model";
		expect(mergePreviousSnapshotModels([], { nebius: { [id]: buildModel(staticModel(id)) } }, new Set())).toEqual([]);
	});

	test("keeps one account's dedicated deployments out of another account's cached roster", async () => {
		await using temp = await TempDir.create("@nebius-cache-");
		const cacheDbPath = temp.join("models.db");
		const roster = (id: string, contextLength: number) => ({
			data: [{ id, context_length: contextLength, architecture: { modality: "text->text" } }],
		});
		const accountA = {
			...nebiusModelManagerOptions({
				apiKey: "key-A",
				fetch: async () => Response.json(roster("dedicated/account-a/private-model", 4096)),
			}),
			cacheDbPath,
		};
		const first = await resolveProviderModels(accountA, "online");
		expect(first.models.map(model => model.id)).toEqual(["dedicated/account-a/private-model"]);

		let accountBRequests = 0;
		const accountB = {
			...nebiusModelManagerOptions({
				apiKey: "key-B",
				fetch: async () => {
					accountBRequests++;
					return Response.json(roster("dedicated/account-b/private-model", 8192));
				},
			}),
			cacheDbPath,
		};
		const second = await resolveProviderModels(accountB, "online-if-uncached");
		expect(accountBRequests).toBe(1);
		expect(second.models.map(model => model.id)).toEqual(["dedicated/account-b/private-model"]);
	});
});

describe("Nebius Token Factory effort vocabularies", () => {
	// The models endpoint publishes no thinking controls, so the reviewed KDL
	// rules carry the deployment effort vocabularies.
	test.each<[string, Effort[]]>([
		["nvidia/Nemotron-3_5-Lightning", [Effort.High]],
		["sa-example/Nemotron-3.5-Lightning-Low-Latency", [Effort.High]],
		["Qwen/Qwen3.8-27B", [Effort.Low, Effort.Medium, Effort.XHigh]],
		["moonshotai/Kimi-K3", [Effort.Low, Effort.Medium, Effort.High, Effort.Max]],
		["MiniMaxAI/MiniMax-M3", [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]],
		["MiniMaxAI/MiniMax-M3.1-Flash", [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]],
		["zai-org/GLM-5.2", [Effort.Low, Effort.Medium, Effort.High]],
		["zai-org/GLM-5.3", [Effort.Low, Effort.High, Effort.Max]],
		["dedicated/sa-example/GLM-5.3-Flash-Fixed-abc123", [Effort.Low, Effort.High, Effort.Max]],
		["dedicated/sa-example/DeepSeek-V4.1-Flash-Coding-Optimized-abc123", [Effort.Low, Effort.High, Effort.Max]],
		["meta-models/muse-spark-open", [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]],
		["reflection/beam", [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]],
	])("offers only the reviewed vocabulary for %s", (id, efforts) => {
		expect(getSupportedEfforts(buildModel(staticModel(id)))).toEqual(efforts);
	});

	test("turns thinking off with none on the serverless models", () => {
		for (const id of ["deepseek-ai/DeepSeek-V4-Flash-0731", "moonshotai/Kimi-K3", "Qwen/Qwen3.8-27B"]) {
			expect(buildModel(staticModel(id)).compat.reasoningDisableMode).toBe("none-effort");
		}
	});
});

describe("Nebius Token Factory reasoning capability", () => {
	/**
	 * A dedicated deployment appears in no public catalog, so the roster's
	 * `supported_features` is the only source that describes what it can do.
	 */
	test("marks a dedicated deployment that the roster reports as reasoning-capable", async () => {
		const options = nebiusModelManagerOptions({
			apiKey: "nebius-test-key",
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "dedicated/sa-example/MiniMax-M3.1-Flash-NVFP4-TP2-abc123",
							context_length: 1048576,
							architecture: { modality: "text+image->text" },
							supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
						},
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.[0]?.reasoning).toBe(true);
	});

	test("marks a row the roster reports as non-reasoning", async () => {
		const options = nebiusModelManagerOptions({
			apiKey: "nebius-test-key",
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "google/gemma-3-27b-it",
							context_length: 110000,
							architecture: { modality: "text->text" },
							supported_features: ["tools"],
						},
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.[0]?.reasoning).toBe(false);
	});

	test.each([
		"MiniMaxAI/MiniMax-M3.1-Flash",
		"dedicated/sa-example/MiniMax-M3.1-Flash-NVFP4-TP2-abc123",
		"deepseek-ai/DeepSeek-V4.1-Flash",
		"sa-example/Nemotron-3.5-Lightning-Low-Latency",
		"reflection/beam",
	])("honors an explicit non-reasoning roster row for %s", async id => {
		await using temp = await TempDir.create("@nebius-reasoning-");
		const options = {
			...nebiusModelManagerOptions({
				apiKey: "nebius-test-key",
				fetch: async () =>
					Response.json({
						data: [
							{
								id,
								context_length: 1048000,
								architecture: { modality: "text->text" },
								supported_features: ["tools"],
							},
						],
					}),
			}),
			cacheDbPath: temp.join("models.db"),
		};
		const result = await resolveProviderModels(options, "online");
		const model = result.models[0];
		// A present `supported_features` array that omits reasoning is a negative
		// verdict; the reviewed lineage ladder must not revive it.
		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
		expect(getSupportedEfforts(model)).toEqual([]);
	});

	test.each<[string, Effort[]]>([
		["dedicated/sa-example/MiniMax-M2.7-Coding-abc", [Effort.Low, Effort.Medium, Effort.High]],
		[
			"dedicated/sa-example/MiniMax-M3-NVFP4-TP2-abc123",
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		],
		[
			"dedicated/sa-example/MiniMax-M3.1-Flash-NVFP4-TP2-abc123",
			[Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		],
		["sa-example/Nemotron-3.5-Lightning-Low-Latency", [Effort.High]],
		["nvidia/Nemotron-3_5-Lightning", [Effort.High]],
		["nvidia/Nemotron-3.5-Super-VL", [Effort.High]],
		["nvidia/Nemotron-3-Ultra-550b-a55b", [Effort.High]],
		["meta-models/muse-spark-open", [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]],
		["reflection/beam", [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]],
	])("repairs an absent capability on a reviewed lineage for %s", (id, efforts) => {
		const model = buildModel({ ...staticModel(id), reasoning: false });
		// The reviewed lineage ladder repairs a neutral spec when the roster
		// says nothing about capability.
		expect(model.reasoning).toBe(true);
		expect(getSupportedEfforts(model)).toEqual(efforts);
	});

	test("keeps an inherited capability when the roster omits supported_features", async () => {
		const options = nebiusModelManagerOptions({
			apiKey: "nebius-test-key",
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "deepseek-ai/DeepSeek-V4.1-Flash",
							context_length: 1048000,
							architecture: { modality: "text->text" },
						},
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		// The bundled reference reports this model as reasoning-capable, and a
		// roster that says nothing must not revoke that.
		expect(models?.[0]?.reasoning).toBe(true);
	});

	test("promotes a dedicated lineage row that omits supported_features", async () => {
		const options = nebiusModelManagerOptions({
			apiKey: "nebius-test-key",
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "dedicated/sa-example/DeepSeek-V4.1-Flash-Coding-Optimized-abc123",
							context_length: 1048000,
							architecture: { modality: "text+image->text" },
						},
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		// No bundled reference exists for a dedicated id; the reviewed lineage
		// ladder is the capability fallback.
		const model = buildModel(models![0]);
		expect(model.reasoning).toBe(true);
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.compat.reasoningDisableMode).toBe("none-effort");
	});
});

describe("Nebius Token Factory MiniMax ladder", () => {
	// The rule selects by lineage (class + reviewed family), not by deployment
	// id, so any deployment of a reviewed generation lands on the same ladder.
	test.each([
		"dedicated/sa-example/MiniMax-M3.1-Flash-NVFP4-TP2-abc123",
		// A future dedicated deployment carries a different team and suffix.
		"dedicated/sa-newteam/MiniMax-M3.1-Flash-NVFP4-TP2-abc123",
		"MiniMaxAI/MiniMax-M3.1-Flash",
	])("offers the MiniMax effort tiers for %s", id => {
		const model = buildModel(staticModel(id));
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(model.thinking?.requiresEffort ?? false).toBe(false);
		expect(model.compat.reasoningDisableMode).toBe("none-effort");
	});

	// The family split keeps the older M2 line on its documented vocabulary
	// (low/medium/high; minimal/xhigh/none 400 on every host) instead of
	// inheriting the family m3 five-tier ladder.
	test("narrows the M2 family to its own vocabulary", () => {
		const model = buildModel(staticModel("dedicated/sa-example/MiniMax-M2.7-Coding-abc"));
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(model.thinking?.requiresEffort).toBe(true);
		expect(model.compat.reasoningDisableMode).toBe("lowest-effort");
	});

	test("keeps M3 on the aggregator ladder Nebius already bakes", () => {
		const model = buildModel(staticModel("MiniMaxAI/MiniMax-M3"));
		expect(getSupportedEfforts(model)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
		expect(model.compat.reasoningDisableMode).toBe("lowest-effort");
	});

	test("leaves other Nebius lineages on their own ladders", () => {
		expect(getSupportedEfforts(buildModel(staticModel("nvidia/nemotron-3-super-120b-a12b")))).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
	});
});
