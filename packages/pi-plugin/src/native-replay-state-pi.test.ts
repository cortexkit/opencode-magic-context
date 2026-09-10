import { describe, expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	updateSessionMeta,
	updateTagDropMode,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import {
	getNativeReasoningIds,
	getNativeToolInputs,
} from "@magic-context/core/features/magic-context/storage-native-replay";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	applyNativeReasoningReplayPi,
	applyNativeToolInputReplayPi,
} from "./native-replay-state-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const model = {
	id: "native-upgrade-codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	contextWindow: 100_000,
	compat: {
		requiresReasoningContentForAllAssistantTurns: false,
		requiresReasoningContentForToolCalls: false,
	},
};
const callId = "call-old|fc-old";
const staleInput = "retained original argument";
const ciphertext = "retained original ciphertext";

function oldAssistant() {
	return assistantMessage("visible answer", 2, {
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{
				type: "thinking",
				thinking: "old summary",
				thinkingSignature: "old signature",
			},
			{ type: "text", text: "visible answer" },
			{
				type: "toolCall",
				id: callId,
				name: "read",
				arguments: { path: staleInput },
			},
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items: [
				{
					type: "reasoning",
					encrypted_content: ciphertext,
					summary: [{ type: "summary_text", text: "old summary" }],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "visible answer" }],
				},
				{
					type: "function_call",
					id: "fc-old",
					call_id: "call-old",
					name: "read",
					arguments: JSON.stringify({ path: staleInput }),
				},
				{
					type: "image_generation_call",
					id: "image-old",
					status: "completed",
					result: "aW1hZ2U=",
				},
			],
		},
	});
}

function nativeBytes(messages: unknown[]): string {
	return JSON.stringify(
		messages
			.filter(
				(message): message is { providerPayload: unknown } =>
					!!message &&
					typeof message === "object" &&
					"providerPayload" in message,
			)
			.map((message) => message.providerPayload),
	);
}

function fixture(sessionId: string) {
	const db = createTestDb();
	const fake = createFakePi();
	const options = {
		db,
		heuristics: { clearReasoningAge: 100 },
		scheduler: { executeThresholdPercentage: 80 },
	};
	const restart = () => {
		clearContextHandlerSession(sessionId);
		registerPiContextHandler(fake.pi as never, options);
	};
	restart();
	const pass = async (percent: number) => {
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const messages = [
			userMessage("first", 1),
			oldAssistant(),
			toolResultMessage(callId, "old output", 3),
			userMessage("continue", 4),
		];
		const handler = fake.handlers.get("context") as (
			event: { messages: never[] },
			ctx: never,
		) => Promise<{ messages: unknown[] } | undefined>;
		const result = await handler({ messages: messages as never[] }, {
			...fakeContext(
				sessionId,
				process.cwd(),
				["entry-user", "entry-old", "entry-result", "entry-next"],
				messages,
			),
			model,
			getContextUsage: () => ({
				percent,
				tokens: percent * 1000,
				contextWindow: 100_000,
			}),
		} as never);
		if (!result) throw new Error("Missing context result");
		return result.messages;
	};
	const seedLegacy = async () => {
		await pass(0);
		const tags = getTagsBySession(db, sessionId);
		const tool = tags.find(
			(tag) => tag.type === "tool" && tag.messageId === callId,
		);
		if (!tool) throw new Error("Missing legacy tool tag");
		updateTagStatus(db, sessionId, tool.tagNumber, "dropped");
		updateTagDropMode(db, sessionId, tool.tagNumber, "full");
		updateSessionMeta(db, sessionId, {
			clearedReasoningThroughTag: Math.max(...tags.map((tag) => tag.tagNumber)),
		});
		expect(getPendingOps(db, sessionId)).toEqual([]);
	};
	return {
		db,
		pass,
		restart,
		seedLegacy,
		close: () => {
			clearContextHandlerSession(sessionId);
			db.close();
		},
	};
}

describe("native upgrade application", () => {
	it("keeps legacy native bytes across defer passes, then persists one authorized transition", async () => {
		const sessionId = "ses-native-upgrade";
		const f = fixture(sessionId);
		try {
			await f.seedLegacy();
			const first = await f.pass(0);
			const a = nativeBytes(first);
			expect(a).toContain(staleInput);
			expect(a).toContain(ciphertext);
			expect(first[1]).toMatchObject({
				content: [
					{ type: "thinking", thinking: "" },
					{},
					{ arguments: { dropped: expect.any(String) } },
				],
			});
			expect(nativeBytes(await f.pass(0))).toBe(a);
			f.restart();
			expect(nativeBytes(await f.pass(0))).toBe(a);
			expect(getNativeToolInputs(f.db, sessionId).size).toBe(0);
			expect(getNativeReasoningIds(f.db, sessionId).size).toBe(0);

			const b = nativeBytes(await f.pass(90));
			expect(b).not.toContain(staleInput);
			expect(b).not.toContain(ciphertext);
			expect(b).toContain("visible answer");
			expect(b).toContain("image_generation_call");
			expect(b).toContain("call-old");
			expect(getNativeToolInputs(f.db, sessionId).has(callId)).toBe(true);
			expect(getNativeReasoningIds(f.db, sessionId).has("entry-old")).toBe(
				true,
			);
			expect(nativeBytes(await f.pass(0))).toBe(b);
			f.restart();
			expect(nativeBytes(await f.pass(0))).toBe(b);
		} finally {
			f.close();
		}
	});

	for (const column of [
		"pi_native_tool_inputs",
		"pi_native_reasoning_ids",
	] as const) {
		it(`does not publish failed ${column} activation or retry it on defer`, async () => {
			const sessionId = `ses-native-failure-${column}`;
			const f = fixture(sessionId);
			try {
				await f.seedLegacy();
				f.db.exec(
					`CREATE TRIGGER fail_native_write BEFORE UPDATE OF ${column} ON session_meta BEGIN SELECT RAISE(FAIL, 'native persistence failure'); END`,
				);
				const failed = nativeBytes(await f.pass(90));
				const retained =
					column === "pi_native_tool_inputs" ? staleInput : ciphertext;
				expect(failed).toContain(retained);
				f.db.exec("DROP TRIGGER fail_native_write");
				expect(nativeBytes(await f.pass(0))).toBe(failed);
				f.restart();
				expect(nativeBytes(await f.pass(0))).toBe(failed);
				const retried = nativeBytes(await f.pass(90));
				expect(retried).not.toContain(retained);
				expect(nativeBytes(await f.pass(0))).toBe(retried);
			} finally {
				f.close();
			}
		});
	}

	it("freezes exact tool input values until another authorized mutation", () => {
		const db = createTestDb();
		const sessionId = "ses-native-input-progress";
		try {
			const run = (marker: string, canApply: boolean, changed = true) => {
				const message = oldAssistant() as unknown as {
					content: Array<{ type: string; arguments?: Record<string, unknown> }>;
				};
				message.content[2].arguments = { dropped: marker };
				const messages: unknown[] = [message];
				applyNativeToolInputReplayPi({
					db,
					sessionId,
					messages,
					canApply,
					changes: changed ? new Map([[0, new Set([callId])]]) : new Map(),
				});
				return nativeBytes(messages);
			};
			const b = run("first marker", true);
			expect(b).toContain("first marker");
			expect(run("different marker", false)).toBe(b);
			expect(run("different marker", false, false)).toBe(b);
			db.exec(
				"CREATE TRIGGER fail_update BEFORE UPDATE OF pi_native_tool_inputs ON session_meta BEGIN SELECT RAISE(FAIL, 'rejected native update'); END",
			);
			expect(run("different marker", true)).toBe(b);
			db.exec("DROP TRIGGER fail_update");
			expect(run("different marker", false)).toBe(b);
			const c = run("different marker", true);
			expect(c).toContain("different marker");
			expect(run("first marker", false)).toBe(c);
		} finally {
			db.close();
		}
	});

	it("waits for a real entry identity before persisting native reasoning", () => {
		const db = createTestDb();
		const sessionId = "ses-native-unresolved-id";
		try {
			const run = (id: string, canApply: boolean) => {
				const messages: unknown[] = [oldAssistant()];
				applyNativeReasoningReplayPi({
					db,
					sessionId,
					messages,
					stableId: () => id,
					messageIdToMaxTag: new Map([[id, 1]]),
					localWatermark: 10,
					clearReasoningAge: 100,
					omissionAllowed: true,
					detectAged: false,
					canApply,
				});
				return nativeBytes(messages);
			};
			const unresolved = run("pi-msg-0-2-assistant", true);
			expect(unresolved).toContain(ciphertext);
			expect(getNativeReasoningIds(db, sessionId).size).toBe(0);
			expect(run("entry-old", false)).toBe(unresolved);
			expect(run("entry-old", false)).toBe(unresolved);
			const cleared = run("entry-old", true);
			expect(cleared).not.toContain(ciphertext);
			expect(run("entry-old", false)).toBe(cleared);
		} finally {
			db.close();
		}
	});

	it("persists native-only reasoning without borrowing or advancing the local watermark", () => {
		const db = createTestDb();
		const sessionId = "ses-native-only";
		try {
			const original = oldAssistant() as unknown as Record<string, unknown>;
			original.content = [{ type: "text", text: "visible answer" }];
			const before = nativeBytes([original]);
			const run = (canApply: boolean) => {
				const messages = [original];
				applyNativeReasoningReplayPi({
					db,
					sessionId,
					messages,
					messageIdToMaxTag: new Map([
						["entry-old", 1],
						["entry-new", 100],
					]),
					stableId: () => "entry-old",
					localWatermark: 0,
					clearReasoningAge: 10,
					omissionAllowed: true,
					detectAged: canApply,
					canApply,
				});
				return nativeBytes(messages);
			};
			const after = run(true);
			expect(after).not.toContain(ciphertext);
			expect(nativeBytes([original])).toBe(before);
			expect(
				getOrCreateSessionMeta(db, sessionId).clearedReasoningThroughTag,
			).toBe(0);
			expect(run(false)).toBe(after);
			expect(run(false)).toBe(after);
		} finally {
			db.close();
		}
	});

	it("does not let tool activation authorize reasoning or age into new reasoning on defer", () => {
		const db = createTestDb();
		const sessionId = "ses-native-independent";
		try {
			getOrCreateSessionMeta(db, sessionId);
			const toolMessage = oldAssistant() as unknown as {
				content: Array<{ arguments?: Record<string, unknown> }>;
			};
			toolMessage.content[2].arguments = { dropped: "native tool marker" };
			applyNativeToolInputReplayPi({
				db,
				sessionId,
				messages: [toolMessage],
				changes: new Map([[0, new Set([callId])]]),
				canApply: true,
			});
			expect(getNativeToolInputs(db, sessionId).has(callId)).toBe(true);
			const run = (
				omissionAllowed: boolean,
				canApply: boolean,
				localWatermark: number,
			) => {
				const messages: unknown[] = [oldAssistant()];
				applyNativeReasoningReplayPi({
					db,
					sessionId,
					messages,
					messageIdToMaxTag: new Map([
						["old", 1],
						["new", 200],
					]),
					stableId: () => "old",
					localWatermark,
					clearReasoningAge: 10,
					omissionAllowed,
					canApply,
					detectAged: false,
				});
				return nativeBytes(messages);
			};
			expect(run(false, true, 10)).toContain(ciphertext);
			expect(getNativeReasoningIds(db, sessionId).size).toBe(0);
			expect(run(true, false, 10)).toContain(ciphertext);
			expect(run(true, true, 0)).toContain(ciphertext);
			const cleared = run(true, true, 10);
			expect(cleared).not.toContain(ciphertext);
			expect(run(true, false, 0)).toBe(cleared);
		} finally {
			db.close();
		}
	});
});
