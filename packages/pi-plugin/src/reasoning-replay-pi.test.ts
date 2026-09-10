import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";

import {
	buildMessageIdToMaxTag,
	clearOldReasoningPi,
	piMessageStableId,
	replayClearedReasoningPi,
	replayStrippedInlineThinkingPi,
	stripInlineThinkingPi,
} from "./reasoning-replay-pi";

setHarness("pi");

function makeDb() {
	const dir = createTestTempDir("pi-reasoning-replay-").dir;
	const path = join(dir, "context.db");
	return openDatabase(path);
}

function fakeTagTarget(messageId: string) {
	return {
		setContent: () => true,
		message: { info: { id: messageId, role: "assistant" }, parts: [] },
	};
}

/** Test helper: throw when piMessageStableId returns undefined. */
function requireId(msg: unknown, index: number): string {
	const id = piMessageStableId(msg, index);
	if (!id)
		throw new Error(`piMessageStableId returned undefined for index=${index}`);
	return id;
}

describe("buildMessageIdToMaxTag", () => {
	it("records the MAX tag number across parts of the same message", () => {
		const targets = new Map<number, ReturnType<typeof fakeTagTarget>>([
			[1, fakeTagTarget("msg-A")],
			[2, fakeTagTarget("msg-A")],
			[3, fakeTagTarget("msg-B")],
		]);
		const result = buildMessageIdToMaxTag(targets);
		expect(result.get("msg-A")).toBe(2);
		expect(result.get("msg-B")).toBe(3);
	});

	it("skips targets with no message id", () => {
		const targets = new Map<number, ReturnType<typeof fakeTagTarget>>([
			[1, { setContent: () => true, message: undefined }],
			[2, fakeTagTarget("msg-A")],
		] as Array<[number, ReturnType<typeof fakeTagTarget>]>);
		const result = buildMessageIdToMaxTag(
			targets as unknown as Map<
				number,
				import("@magic-context/core/hooks/magic-context/tag-messages").TagTarget
			>,
		);
		expect(result.size).toBe(1);
		expect(result.get("msg-A")).toBe(2);
	});
});

describe("piMessageStableId", () => {
	it("matches the format used by transcript-pi.ts", () => {
		expect(piMessageStableId({ role: "user", timestamp: 1234 }, 5)).toBe(
			"pi-msg-5-1234-user",
		);
		expect(piMessageStableId({ role: "assistant" }, 7)).toBe(
			"pi-msg-7-assistant",
		);
	});
});

describe("clearOldReasoningPi", () => {
	it("clears thinking on assistant messages whose tag is below the age cutoff", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [
					{ type: "thinking", thinking: "old reasoning" },
					{ type: "text", text: "old reply" },
				],
			},
			{
				role: "assistant",
				timestamp: 2,
				content: [
					{ type: "thinking", thinking: "recent reasoning" },
					{ type: "text", text: "recent reply" },
				],
			},
		];
		// Pretend tags 1..2 exist; clear messages with tag <= 1 (one message older than age 1).
		const id0 = piMessageStableId(messages[0], 0);
		const id1 = piMessageStableId(messages[1], 1);
		if (!id0 || !id1) throw new Error("piMessageStableId returned undefined");
		const messageIdToMaxTag = new Map<string, number>([
			[id0, 1],
			[id1, 2],
		]);
		const result = clearOldReasoningPi({
			messages,
			messageIdToMaxTag,
			clearReasoningAge: 1,
			piMessageStableId,
		});
		expect(result.cleared).toBe(1);
		expect(result.newWatermark).toBe(1);
		// Old reasoning is emptied (not "[cleared]"); every Pi serializer drops an
		// empty thinking block before the wire.
		expect(messages[0].content[0]).toMatchObject({
			type: "thinking",
			thinking: "",
		});
		// Recent message untouched.
		expect(messages[1].content[0]).toMatchObject({
			type: "thinking",
			thinking: "recent reasoning",
		});
	});

	it("leaves native-only reasoning to the native coordinator without advancing the local watermark", () => {
		const native = {
			type: "openaiResponsesHistory",
			dt: true,
			items: [
				{ type: "reasoning", encrypted_content: "persisted-only-reasoning" },
				{
					type: "function_call",
					id: "fc1",
					call_id: "call1",
					name: "read",
					arguments: "{}",
				},
			],
		};
		const nativeSnapshot = structuredClone(native);
		const localMessage = {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "thinking", thinking: "local thinking" }],
		};
		const nativeOnlyMessage = {
			role: "assistant",
			timestamp: 2,
			content: [
				{ type: "toolCall", id: "call1|fc1", name: "read", arguments: {} },
			],
			providerPayload: native,
		};
		const messages = [localMessage, nativeOnlyMessage];
		const result = clearOldReasoningPi({
			messages,
			messageIdToMaxTag: new Map([
				["local", 1],
				["native", 2],
				["recent", 10],
			]),
			clearReasoningAge: 3,
			piMessageStableId: (_message, index) =>
				index === 0 ? "local" : "native",
		});

		expect(result).toEqual({ cleared: 1, newWatermark: 1 });
		expect(localMessage.content).toEqual([{ type: "thinking", thinking: "" }]);
		expect(nativeOnlyMessage.providerPayload).toBe(native);
		expect(nativeOnlyMessage.providerPayload).toEqual(nativeSnapshot);
	});

	it("preserves a full native snapshot while clearing local Pi thinking and replaying its watermark", () => {
		const db = makeDb();
		const sessionId = "ses-native-snapshot";
		try {
			const native = {
				type: "openaiResponsesHistory",
				dt: false,
				items: [{ type: "reasoning", encrypted_content: "snapshot-reasoning" }],
			};
			const original = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "required history",
						thinkingSignature: "sig",
					},
					{ type: "text", text: "reply" },
				],
				providerPayload: native,
			};
			const nativeSnapshot = structuredClone(native);
			const messageIdToMaxTag = new Map<string, number>([
				["a", 1],
				["recent", 10],
			]);
			const options = {
				messageIdToMaxTag,
				piMessageStableId: () => "a",
			};

			const first = structuredClone(original);
			const cleared = clearOldReasoningPi({
				...options,
				messages: [first],
				clearReasoningAge: 3,
			});
			expect(cleared).toEqual({ cleared: 1, newWatermark: 1 });
			expect(first.content).toEqual([
				{ type: "thinking", thinking: "" },
				{ type: "text", text: "reply" },
			]);
			expect(first.providerPayload).toEqual(nativeSnapshot);

			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				clearedReasoningThroughTag: cleared.newWatermark,
			});
			const resumed = structuredClone(original);
			expect(
				replayClearedReasoningPi({
					...options,
					messages: [resumed],
					db,
					sessionId,
				}),
			).toBe(1);
			expect(resumed).toEqual(first);
			expect(resumed.providerPayload).toEqual(nativeSnapshot);
		} finally {
			db.close();
		}
	});

	it("does nothing when ageCutoff is 0 or below", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [{ type: "thinking", thinking: "a" }],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
		]);
		const result = clearOldReasoningPi({
			messages,
			messageIdToMaxTag,
			clearReasoningAge: 5, // larger than maxTag → ageCutoff = -4
			piMessageStableId,
		});
		expect(result.cleared).toBe(0);
		expect(result.newWatermark).toBe(0);
	});

	it("preserves redacted and native blocks while clearing ordinary local thinking", () => {
		// Redacted blocks serialize before empty blocks, so they remain verbatim;
		// ordinary local thinking in the same message must still be cleared.
		const db = makeDb();
		const sessionId = "ses-mixed-generic-thinking";
		try {
			const native = {
				type: "openaiResponsesHistory",
				dt: true,
				items: [
					{ type: "reasoning", encrypted_content: "opaque native reasoning" },
				],
			};
			const original = {
				role: "assistant",
				timestamp: 1,
				providerPayload: native,
				content: [
					{
						type: "thinking",
						thinking: "opaque-redacted-payload",
						thinkingSignature: "sig-abc",
						redacted: true,
					},
					{
						type: "thinking",
						thinking: "ordinary local thinking",
						thinkingSignature: "ordinary-signature",
					},
					{ type: "text", text: "reply" },
				],
			};
			const messageIdToMaxTag = new Map<string, number>([
				[requireId(original, 0), 1],
				["recent", 4],
			]);
			const options = {
				messageIdToMaxTag,
				piMessageStableId,
			};

			const first = structuredClone(original);
			const cleared = clearOldReasoningPi({
				...options,
				messages: [first],
				clearReasoningAge: 2,
			});
			expect(cleared).toEqual({ cleared: 1, newWatermark: 1 });
			expect(first.content).toEqual([
				{
					type: "thinking",
					thinking: "opaque-redacted-payload",
					thinkingSignature: "sig-abc",
					redacted: true,
				},
				{ type: "thinking", thinking: "" },
				{ type: "text", text: "reply" },
			]);
			expect(first.providerPayload).toEqual(native);

			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				clearedReasoningThroughTag: cleared.newWatermark,
			});
			const resumed = structuredClone(original);
			expect(
				replayClearedReasoningPi({
					...options,
					messages: [resumed],
					db,
					sessionId,
				}),
			).toBe(1);
			expect(resumed).toEqual(first);
		} finally {
			db.close();
		}
	});
});

describe("replayClearedReasoningPi", () => {
	it("replays emptied thinking for assistant parts below the watermark", () => {
		const db = makeDb();
		const sessionId = "ses_replay_pi_1";
		// First make the session_meta row exist.
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, { clearedReasoningThroughTag: 1 });

		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [{ type: "thinking", thinking: "should be cleared" }],
			},
			{
				role: "assistant",
				timestamp: 2,
				content: [{ type: "thinking", thinking: "still visible" }],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
			[requireId(messages[1], 1), 2],
		]);
		const cleared = replayClearedReasoningPi({
			db,
			sessionId,
			messages,
			messageIdToMaxTag,
			piMessageStableId,
		});
		expect(cleared).toBe(1);
		expect(messages[0].content[0]).toMatchObject({ thinking: "" });
		expect(messages[1].content[0]).toMatchObject({ thinking: "still visible" });
	});
});

describe("stripInlineThinkingPi", () => {
	it("strips both inline thinking tag forms below the age cutoff and reports a watermark", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "text",
						text: "A <thinking>secret</thinking> visible",
					},
				],
			},
			{
				role: "assistant",
				timestamp: 2,
				content: [{ type: "text", text: "B <think>hidden</think> visible" }],
			},
			{
				role: "assistant",
				timestamp: 3,
				content: [
					{
						type: "text",
						text: "C <thinking>keep</thinking><think>keep</think> visible",
					},
				],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
			[requireId(messages[1], 1), 2],
			[requireId(messages[2], 2), 3],
		]);

		const result = stripInlineThinkingPi({
			messages,
			messageIdToMaxTag,
			clearReasoningAge: 1,
			piMessageStableId,
		});

		expect(result).toEqual({ stripped: 2, newWatermark: 2 });
		expect(messages[0].content[0]).toMatchObject({ text: "A visible" });
		expect(messages[1].content[0]).toMatchObject({ text: "B visible" });
		expect(messages[2].content[0]).toMatchObject({
			text: "C <thinking>keep</thinking><think>keep</think> visible",
		});
	});
});

describe("replayStrippedInlineThinkingPi", () => {
	it("strips inline <thinking>...</thinking> from text parts below the watermark", () => {
		const db = makeDb();
		const sessionId = "ses_inline_pi_1";
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, { clearedReasoningThroughTag: 1 });

		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "text",
						text: "Hello <thinking>secret</thinking> world",
					},
				],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
		]);
		const stripped = replayStrippedInlineThinkingPi({
			db,
			sessionId,
			messages,
			messageIdToMaxTag,
			piMessageStableId,
		});
		expect(stripped).toBe(1);
		expect(messages[0].content[0]).toMatchObject({
			type: "text",
			text: "Hello world",
		});
	});

	it("returns 0 when no watermark is set", () => {
		const db = makeDb();
		const sessionId = "ses_inline_pi_2";
		getOrCreateSessionMeta(db, sessionId);
		// no watermark update — defaults to 0
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [{ type: "text", text: "<thinking>nope</thinking>untouched" }],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
		]);
		const stripped = replayStrippedInlineThinkingPi({
			db,
			sessionId,
			messages,
			messageIdToMaxTag,
			piMessageStableId,
		});
		expect(stripped).toBe(0);
	});
});
