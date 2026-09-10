import { describe, expect, it } from "bun:test";
import {
	canClearNativeReasoning,
	clearNativeReasoning,
	rewriteNativeToolInput,
} from "./native-replay-pi";

type NativeItem = Record<string, unknown>;

function nativeMessage(items: NativeItem[], dt = true) {
	return {
		role: "assistant",
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			dt,
			items,
		},
	};
}

const optionalReasoning = {
	requiresReasoningContentForAllAssistantTurns: false,
	requiresReasoningContentForToolCalls: false,
};

describe("native tool input reductions", () => {
	it("changes only the selected function input without losing native-only history", () => {
		const reasoning = {
			type: "reasoning",
			encrypted_content: "retain-encrypted-history",
		};
		const image = { type: "image_generation_call", result: "retain-image" };
		const text = {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "retain explanation" }],
		};
		const call = {
			type: "function_call",
			id: "fc1",
			call_id: "call1",
			name: "read",
			arguments: JSON.stringify({ path: "original.txt" }),
		};
		const message = nativeMessage([reasoning, image, text, call]);
		const original = message.providerPayload;
		const before = structuredClone(original);

		rewriteNativeToolInput(message, "call1|fc1", {
			dropped: "[dropped input]",
		});

		expect(message.providerPayload.items).toEqual([
			reasoning,
			image,
			text,
			{ ...call, arguments: JSON.stringify({ dropped: "[dropped input]" }) },
		]);
		expect(original).toEqual(before);
		expect(message.providerPayload.provider).toBe(original.provider);
	});

	it("uses the existing OMP custom-input fallback instead of replaying stale raw input", () => {
		const call = {
			type: "custom_tool_call",
			id: "ctc1",
			call_id: "call1",
			name: "apply_patch",
			input: "original patch",
		};
		const message = nativeMessage([call]);
		rewriteNativeToolInput(message, "call1|ctc1", {
			input: "replacement patch",
		});
		expect(message.providerPayload.items[0]).toEqual({
			...call,
			input: "replacement patch",
		});
		rewriteNativeToolInput(message, "call1|ctc1", {
			dropped: "[dropped input]",
		});
		expect(message.providerPayload.items[0]).toEqual({ ...call, input: "" });
		expect(call.input).toBe("original patch");
	});

	it("leaves native function input untouched when generic arguments cannot produce JSON", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const unsupportedInputs: Record<string, unknown>[] = [
			circular,
			{ count: BigInt(1) },
			{
				toJSON() {
					throw new Error("serialization failed");
				},
			},
			{
				toJSON() {
					return undefined;
				},
			},
		];

		for (const input of unsupportedInputs) {
			const call = {
				type: "function_call",
				id: "fc1",
				call_id: "call1",
				name: "read",
				arguments: JSON.stringify({ path: "original.txt" }),
			};
			const message = nativeMessage([call]);
			const payload = message.providerPayload;
			const before = structuredClone(payload);

			rewriteNativeToolInput(message, "call1|fc1", input);

			expect(message.providerPayload).toBe(payload);
			expect(message.providerPayload).toEqual(before);
		}
	});

	it("matches unique id-less calls when OMP supplies a synthesized block id", () => {
		const call = {
			type: "function_call",
			call_id: "function1",
			name: "read",
			arguments: JSON.stringify({ path: "original.txt" }),
		};
		const custom = {
			type: "custom_tool_call",
			call_id: "custom1",
			name: "apply_patch",
			input: "original patch",
		};
		const message = nativeMessage([call, custom]);
		rewriteNativeToolInput(message, "function1|fc_synthesized", {
			dropped: "[dropped]",
		});
		rewriteNativeToolInput(message, "custom1|fc_synthesized", {
			dropped: "[dropped]",
		});
		expect(message.providerPayload.items).toEqual([
			{ ...call, arguments: JSON.stringify({ dropped: "[dropped]" }) },
			{ ...custom, input: "" },
		]);
		expect(message.providerPayload.items[0]).not.toHaveProperty("id");
		expect(message.providerPayload.items[1]).not.toHaveProperty("id");
	});

	it("does not guess between duplicate, mismatched, or ambiguous id-less calls", () => {
		const call = {
			type: "function_call",
			id: "fc1",
			call_id: "call1",
			name: "read",
			arguments: "{}",
		};
		const duplicate = nativeMessage([call, { ...call }]);
		const mismatched = nativeMessage([call]);
		const ambiguous = nativeMessage([
			call,
			{
				type: "function_call",
				call_id: "call1",
				name: "read",
				arguments: "{}",
			},
		]);
		for (const message of [duplicate, mismatched, ambiguous]) {
			const payload = message.providerPayload;
			rewriteNativeToolInput(message, "call1|fc_other", {
				dropped: "[dropped]",
			});
			expect(message.providerPayload).toBe(payload);
		}
		const payload = duplicate.providerPayload;
		rewriteNativeToolInput(duplicate, "call1|fc1", { dropped: "[dropped]" });
		expect(duplicate.providerPayload).toBe(payload);
	});

	it("preserves the replay object when the input is already reduced", () => {
		const input = { dropped: "[dropped]" };
		const message = nativeMessage([
			{
				type: "function_call",
				id: "fc1",
				call_id: "call1",
				name: "read",
				arguments: JSON.stringify(input),
			},
		]);
		const payload = message.providerPayload;
		rewriteNativeToolInput(message, "call1", input);
		expect(message.providerPayload).toBe(payload);
	});

	it("reduces a selected snapshot call without replacing the snapshot or its other history", () => {
		const history = {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "authoritative history" }],
		};
		const call = {
			type: "function_call",
			id: "fc1",
			call_id: "call1",
			name: "read",
			arguments: "{}",
		};
		const message = nativeMessage([history, call], false);
		rewriteNativeToolInput(message, "call1|fc1", { dropped: "[dropped]" });
		expect(message.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			dt: false,
			items: [
				history,
				{ ...call, arguments: JSON.stringify({ dropped: "[dropped]" }) },
			],
		});
	});
});

describe("native reasoning retention", () => {
	it("permits clearing only when the Codex model explicitly allows reasoning omission", () => {
		expect(
			canClearNativeReasoning({
				api: "openai-codex-responses",
				compat: optionalReasoning,
			}),
		).toBe(true);
		expect(canClearNativeReasoning(undefined)).toBe(false);
		expect(
			canClearNativeReasoning({ api: "openai-codex-responses", compat: {} }),
		).toBe(false);
		expect(
			canClearNativeReasoning({
				api: "openai-responses",
				compat: optionalReasoning,
			}),
		).toBe(false);
		for (const compat of [
			{
				...optionalReasoning,
				requiresReasoningContentForAllAssistantTurns: true,
			},
			{ ...optionalReasoning, requiresReasoningContentForToolCalls: true },
			{
				...optionalReasoning,
				whenThinking: {
					...optionalReasoning,
					requiresReasoningContentForAllAssistantTurns: true,
				},
			},
			{ ...optionalReasoning, whenThinking: {} },
		]) {
			expect(
				canClearNativeReasoning({ api: "openai-codex-responses", compat }),
			).toBe(false);
		}
	});

	it("removes eligible opaque reasoning without dropping other native items or changing source history", () => {
		const reasoning = {
			type: "reasoning",
			encrypted_content: "opaque-encrypted-content",
			content: [],
		};
		const text = {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "keep" }],
		};
		const call = {
			type: "function_call",
			call_id: "call1",
			name: "read",
			arguments: "{}",
		};
		const image = { type: "image_generation_call", result: "keep" };
		const message = nativeMessage([reasoning, text, call, image]);
		const original = message.providerPayload;
		expect(clearNativeReasoning(message, true)).toBe("cleared");
		expect(message.providerPayload.items).toEqual([text, call, image]);
		expect(original.items).toEqual([reasoning, text, call, image]);
	});

	it("clears eligible encrypted native reasoning with a display summary", () => {
		const reasoning = {
			type: "reasoning",
			encrypted_content: "opaque-encrypted-content",
			summary: [{ type: "summary_text", text: "displayed thinking" }],
		};
		const text = {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "keep" }],
		};
		const message = nativeMessage([reasoning, text]);
		const original = message.providerPayload;

		expect(clearNativeReasoning(message, true)).toBe("cleared");
		expect(message.providerPayload.items).toEqual([text]);
		expect(original.items).toEqual([reasoning, text]);
	});

	it("retains native reasoning when the active model has not authorized omission", () => {
		const message = nativeMessage([
			{ type: "reasoning", encrypted_content: "must-stay" },
		]);
		const payload = message.providerPayload;
		expect(clearNativeReasoning(message, false)).toBe("preserved");
		expect(message.providerPayload).toBe(payload);
	});

	it("keeps snapshots, plaintext, malformed, redacted and computer-linked reasoning intact", () => {
		const encrypted = { type: "reasoning", encrypted_content: "keep" };
		const cases = [
			nativeMessage([encrypted], false),
			nativeMessage([
				{
					...encrypted,
					content: [{ type: "reasoning_text", text: "required plaintext" }],
				},
			]),
			nativeMessage([
				encrypted,
				{
					type: "reasoning",
					content: [{ type: "reasoning_text", text: "required" }],
				},
			]),
			nativeMessage([{ type: "reasoning", encrypted_content: "" }]),
			nativeMessage([
				encrypted,
				{ type: "computer_call", call_id: "computer1" },
			]),
			{
				...nativeMessage([encrypted]),
				content: [{ type: "thinking", thinking: "opaque", redacted: true }],
			},
		];
		for (const message of cases) {
			const payload = message.providerPayload;
			expect(clearNativeReasoning(message, true)).toBe("preserved");
			expect(message.providerPayload).toBe(payload);
		}
	});

	it("leaves ordinary Pi messages and other provider payloads unchanged", () => {
		const message = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "ordinary Pi reasoning" }],
			providerPayload: { type: "anthropicMessage", content: "keep" },
		};
		const before = structuredClone(message);
		expect(clearNativeReasoning(message, true)).toBe("not-native");
		rewriteNativeToolInput(message, "call1", { dropped: "[dropped]" });
		expect(message).toEqual(before);
		expect(clearNativeReasoning(nativeMessage([]), true)).toBe("not-native");
	});
});
