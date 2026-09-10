import { isRecord } from "@magic-context/core/shared/record-type-guard";

type NativeEnvelope = {
	message: Record<string, unknown>;
	payload: Record<string, unknown>;
	items: unknown[];
};

type ToolCallIdentity = {
	callId: string;
	itemId?: string;
};

type ToolCallMatch = {
	index: number;
	item: Record<string, unknown>;
	kind: "function_call" | "custom_tool_call";
};

function getNativeEnvelope(message: unknown): NativeEnvelope | undefined {
	if (!isRecord(message)) return undefined;
	const payload = message.providerPayload;
	if (
		!isRecord(payload) ||
		payload.type !== "openaiResponsesHistory" ||
		!Array.isArray(payload.items)
	) {
		return undefined;
	}
	return { message, payload, items: payload.items };
}

function parseToolCallId(toolCallId: string): ToolCallIdentity | undefined {
	if (toolCallId.length === 0) return undefined;

	const separator = toolCallId.indexOf("|");
	if (separator === -1) return { callId: toolCallId };
	if (
		separator === 0 ||
		separator === toolCallId.length - 1 ||
		toolCallId.indexOf("|", separator + 1) !== -1
	) {
		return undefined;
	}
	return {
		callId: toolCallId.slice(0, separator),
		itemId: toolCallId.slice(separator + 1),
	};
}

function findNativeToolCall(
	items: unknown[],
	identity: ToolCallIdentity,
): ToolCallMatch | undefined {
	let match: ToolCallMatch | undefined;
	let matchingCallIds = 0;

	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!isRecord(item)) continue;
		const kind = item.type;
		if (kind !== "function_call" && kind !== "custom_tool_call") continue;
		if (item.call_id !== identity.callId) continue;
		matchingCallIds++;
		if (
			identity.itemId !== undefined &&
			typeof item.id === "string" &&
			item.id.length > 0 &&
			item.id !== identity.itemId
		) {
			continue;
		}
		if (match !== undefined) return undefined;
		match = { index, item, kind };
	}

	// OMP synthesizes block ids when the captured native item has no id.
	if (
		match &&
		(typeof match.item.id !== "string" || match.item.id.length === 0) &&
		matchingCallIds !== 1
	) {
		return undefined;
	}
	return match;
}

export function rewriteNativeToolInput(
	message: unknown,
	toolCallId: string,
	input: Record<string, unknown>,
): void {
	const envelope = getNativeEnvelope(message);
	if (!envelope) return;

	const identity = parseToolCallId(toolCallId);
	if (!identity) return;
	const match = findNativeToolCall(envelope.items, identity);
	if (!match) return;

	const field = match.kind === "function_call" ? "arguments" : "input";
	let nextValue: string | undefined;
	if (match.kind === "function_call") {
		try {
			nextValue = JSON.stringify(input);
		} catch {
			return;
		}
	} else {
		nextValue = typeof input.input === "string" ? input.input : "";
	}
	if (typeof nextValue !== "string" || match.item[field] === nextValue) return;

	const items = envelope.items.slice();
	items[match.index] = { ...match.item, [field]: nextValue };
	envelope.message.providerPayload = { ...envelope.payload, items };
}

function hasRedactedThinkingContent(message: Record<string, unknown>): boolean {
	if (!Array.isArray(message.content)) return false;
	for (const part of message.content) {
		if (isRecord(part) && part.type === "thinking" && part.redacted === true)
			return true;
	}
	return false;
}

export function canClearNativeReasoning(model: unknown): boolean {
	if (
		!isRecord(model) ||
		model.api !== "openai-codex-responses" ||
		!isRecord(model.compat)
	) {
		return false;
	}
	const compat = model.compat;
	if (
		compat.requiresReasoningContentForAllAssistantTurns !== false ||
		compat.requiresReasoningContentForToolCalls !== false
	) {
		return false;
	}
	if (compat.whenThinking == null) return true;
	return (
		isRecord(compat.whenThinking) &&
		compat.whenThinking.requiresReasoningContentForAllAssistantTurns ===
			false &&
		compat.whenThinking.requiresReasoningContentForToolCalls === false
	);
}

export function clearNativeReasoning(
	message: unknown,
	allowed: boolean,
): "not-native" | "cleared" | "preserved" {
	const envelope = getNativeEnvelope(message);
	if (!envelope) return "not-native";
	if (hasRedactedThinkingContent(envelope.message)) return "preserved";

	let reasoningCount = 0;
	let hasComputerCall = false;
	for (const item of envelope.items) {
		if (!isRecord(item)) continue;
		if (item.type === "computer_call") {
			hasComputerCall = true;
			continue;
		}
		if (item.type !== "reasoning") continue;

		reasoningCount += 1;
		if (
			typeof item.encrypted_content !== "string" ||
			item.encrypted_content.length === 0 ||
			(item.content !== undefined &&
				(!Array.isArray(item.content) || item.content.length > 0))
		) {
			return "preserved";
		}
	}

	if (reasoningCount === 0) return "not-native";
	if (!allowed || envelope.payload.dt !== true || hasComputerCall) {
		return "preserved";
	}

	const items = envelope.items.filter(
		(item) => !isRecord(item) || item.type !== "reasoning",
	);
	envelope.message.providerPayload = { ...envelope.payload, items };
	return "cleared";
}
