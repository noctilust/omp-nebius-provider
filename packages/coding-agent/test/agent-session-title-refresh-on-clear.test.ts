/**
 * `/clear` keeps the session, its title and its card, but replaces the
 * conversation that title was generated from, so an auto title is re-considered
 * once the first run of the new conversation settles (`title.refreshOnClear`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TitleChangeEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as titleDriftClassifier from "@oh-my-pi/pi-coding-agent/session/title-drift-classifier";
import { createAssistantMessage } from "./helpers/agent-session-setup";

/** The session's own title, card included: a refresh has to keep the card. */
const CARD_TITLE = "🧪 FLAKY: Fix flaky park tests";
/** What the title model answers with when a refresh regenerates the title. */
const RETITLED = "Rebuild the docs pipeline";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
// Earlier full-suite files that boot main() in ACP/RPC mode set PI_NO_TITLE=1
// process-wide and never restore it; automatic titling gates on it.
let previousNoTitle: string | undefined;

beforeEach(() => {
	previousNoTitle = Bun.env.PI_NO_TITLE;
	delete Bun.env.PI_NO_TITLE;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
	else Bun.env.PI_NO_TITLE = previousNoTitle;
});

/** A session whose main turns answer with a canned reply and whose titles come from the title model. */
async function createSession(settingsOverride: Record<string, unknown> = {}): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	let replies = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: () => {
			const response = createAssistantMessage(`reply ${++replies}`);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop", message: response });
			});
			return stream;
		},
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			modelRoles: { tiny: `${model.provider}/${model.id}` },
			// An emoji card renders whatever symbol preset the suite left behind.
			"title.icons": "emoji",
			...settingsOverride,
		}),
		modelRegistry: new ModelRegistry(authStorage),
		autoTitle: true,
	});
	return session;
}

/** The reply the title model would send to name the session `title`. */
const titleReply = (title: string) =>
	({ stopReason: "stop", content: [{ type: "text", text: `<title>${title}</title>` }] }) as never;

/** Resolves once the session's title becomes `expected`. */
function waitForSessionName(expected: string): Promise<void> {
	if (session?.sessionManager.getSessionName() === expected) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = session!.sessionManager.onSessionNameChanged(() => {
		if (session!.sessionManager.getSessionName() !== expected) return;
		unsubscribe();
		resolve();
	});
	return promise;
}

describe("AgentSession title refresh after /clear", () => {
	it("re-considers a generated title from the new conversation and keeps its card", async () => {
		const active = await createSession();
		await active.setSessionName(CARD_TITLE, "auto");
		const drifted = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(true);
		const titles = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleReply(RETITLED));

		await active.prompt("fix the flaky park tests");
		await active.resetSessionContext();
		// The boundary itself changes nothing: the check waits for the new conversation.
		expect(drifted).not.toHaveBeenCalled();

		const retitled = waitForSessionName(`🧪 FLAKY: ${RETITLED}`);
		await active.prompt("rebuild the docs pipeline");
		await retitled;

		expect(drifted).toHaveBeenCalledTimes(1);
		const [, title, recent] = drifted.mock.calls[0]!;
		// The classifier receives the full card title (it strips the card itself),
		// and sees only the conversation after the boundary.
		expect(title).toBe(CARD_TITLE);
		expect(recent).toContainEqual({ role: "user", text: "rebuild the docs pipeline" });
		expect(recent.some(turn => turn.text.includes("park tests"))).toBe(false);
		expect(titles).toHaveBeenCalledTimes(1);
		const changes = active.sessionManager
			.getEntries()
			.filter((entry): entry is TitleChangeEntry => entry.type === "title_change");
		expect(changes.at(-1)?.trigger).toBe("reset");
	});

	it("keeps the title when the judge still calls it fitting", async () => {
		const active = await createSession();
		await active.setSessionName(CARD_TITLE, "auto");
		const judged = Promise.withResolvers<void>();
		vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockImplementation(async () => {
			judged.resolve();
			return false;
		});
		const titles = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleReply(RETITLED));

		await active.prompt("fix the flaky park tests");
		await active.resetSessionContext();
		await active.prompt("rebuild the docs pipeline");
		await judged.promise;

		expect(titles).not.toHaveBeenCalled();
		expect(active.sessionManager.getSessionName()).toBe(CARD_TITLE);
	});

	it("leaves the title alone when title.refreshOnClear is disabled", async () => {
		const active = await createSession({ "title.refreshOnClear": false });
		await active.setSessionName(CARD_TITLE, "auto");
		const drifted = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(true);
		const titles = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleReply(RETITLED));

		await active.prompt("fix the flaky park tests");
		await active.resetSessionContext();
		await active.prompt("rebuild the docs pipeline");
		// One more settled run: a check started by the boundary would have landed by now.
		await active.prompt("now run the release build");

		expect(drifted).not.toHaveBeenCalled();
		expect(titles).not.toHaveBeenCalled();
		expect(active.sessionManager.getSessionName()).toBe(CARD_TITLE);
	});

	it("never replaces a title the user set", async () => {
		const active = await createSession();
		await active.setSessionName("Manual park title", "user");
		const drifted = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(true);
		const titles = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleReply(RETITLED));

		await active.prompt("fix the flaky park tests");
		await active.resetSessionContext();
		await active.prompt("rebuild the docs pipeline");

		expect(drifted).not.toHaveBeenCalled();
		expect(titles).not.toHaveBeenCalled();
		expect(active.sessionManager.getSessionName()).toBe("Manual park title");
	});

	it("counts title.refreshAfterPrompts from the new conversation only", async () => {
		const active = await createSession({ "title.refreshOnClear": false, "title.refreshAfterPrompts": 2 });
		await active.setSessionName("Fix parser recovery", "auto");
		const drifted = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(false);

		await active.prompt("add a regression test for parser recovery");
		await active.resetSessionContext();
		// A count carried across the boundary would fire the check here.
		await active.prompt("run the parser tests");
		expect(drifted).not.toHaveBeenCalled();

		await active.prompt("fix the failing parser test");
		expect(drifted).toHaveBeenCalledTimes(1);
	});

	it("runs the check at a later settled run when earlier title work is still running", async () => {
		const active = await createSession({ "title.refreshAfterPrompts": 1 });
		await active.setSessionName(CARD_TITLE, "auto");
		// The pre-clear prompt-count check hangs past the boundary and the next settled run.
		const slowVerdict = Promise.withResolvers<boolean | undefined>();
		const drifted = vi
			.spyOn(titleDriftClassifier, "classifyTitleDrift")
			.mockReturnValueOnce(slowVerdict.promise)
			.mockResolvedValue(true);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(titleReply(RETITLED));

		await active.prompt("fix the flaky park tests");
		expect(drifted).toHaveBeenCalledTimes(1);
		await active.resetSessionContext();
		// Low-signal prompts do not count toward `title.refreshAfterPrompts`: only the boundary can check.
		await active.prompt("ok thanks");
		expect(drifted).toHaveBeenCalledTimes(1);

		// The released judgment unwinds well within the next prompt's round trip.
		slowVerdict.resolve(false);
		const retitled = waitForSessionName(`🧪 FLAKY: ${RETITLED}`);
		await active.prompt("thanks");
		await retitled;

		expect(drifted).toHaveBeenCalledTimes(2);
		const [, , recent] = drifted.mock.calls[1]!;
		expect(recent).toContainEqual({ role: "user", text: "thanks" });
		expect(recent.some(turn => turn.text.includes("park tests"))).toBe(false);
		const changes = active.sessionManager
			.getEntries()
			.filter((entry): entry is TitleChangeEntry => entry.type === "title_change");
		expect(changes.at(-1)?.trigger).toBe("reset");
	});

	it("lets one judged check answer both the boundary and the prompt count", async () => {
		const active = await createSession({ "title.refreshAfterPrompts": 2 });
		await active.setSessionName(CARD_TITLE, "auto");
		const drifted = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(false);

		await active.resetSessionContext();
		await active.prompt("rebuild the docs pipeline");
		expect(drifted).toHaveBeenCalledTimes(1);
		// The boundary check consumed the prompt it counted: one more prompt is not yet two.
		await active.prompt("wire the docs pipeline into CI");
		expect(drifted).toHaveBeenCalledTimes(1);
		await active.prompt("publish the docs pipeline");
		expect(drifted).toHaveBeenCalledTimes(2);
	});
});
