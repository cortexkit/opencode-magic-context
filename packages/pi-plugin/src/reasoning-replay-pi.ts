/**
 * Pi-side reasoning clearing & inline-thinking strip — mirrors
 * OpenCode's `clearOldReasoning`, `replayClearedReasoning`, and
 * `replayStrippedInlineThinking`.
 *
 * Why this matters for Pi:
 *   - Pi assistants carry `(PiTextContent | PiThinkingContent | PiToolCall)[]`
 *     in their `content` arrays.
 *   - Older assistant turns' thinking content stays visible to the
 *     model on every pass, wasting tokens AND mutating cached prefix
 *     content if it ever changes shape (e.g. thinking blocks getting
 *     stripped lazily by the provider). Both are exactly what
 *     OpenCode's reasoning-clearing replay was added to fix.
 *
 * Behavior:
 *   - On execute passes (cache-busting): walk Pi assistant messages
 *     whose tag number is older than `clear_reasoning_age` from the
 *     newest tag, EMPTY each `PiThinkingContent.thinking` (and drop its
 *     stale signature), persist watermark = max-tag-cleared in
 *     `session_meta.cleared_reasoning_through_tag`. Pi serializers drop
 *     empty thinking before the wire, so nothing (and no stale signature)
 *     reaches any provider.
 *   - On EVERY pass (including defer): replay the cleared state from
 *     the watermark so the message array stays byte-stable — same
 *     contract as OpenCode's `replayClearedReasoning`.
 *   - Inline `<thinking>...</thinking>` markup in text content is also
 *     stripped on every pass via the same watermark.
 *
 * Providers with `capabilities.interleaved.field` (e.g. Moonshot/Kimi
 * `reasoning_content`) used to need a special bypass to keep typed
 * reasoning intact. OpenCode PR #24146 (preserve empty reasoning_content
 * for DeepSeek V4 thinking mode) made the provider transform always
 * emit the interleaved field — empty when no reasoning parts remain —
 * so the bypass is no longer needed.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";

type PiTextContent = { type: "text"; text: string };
type PiThinkingContent = {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
};
type PiToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};
type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCall;
type PiAssistantMessage = {
	role: "assistant";
	content: PiAssistantContent[];
	timestamp?: number;
};

const INLINE_THINKING_PATTERNS = [
	/<thinking>[\s\S]*?<\/thinking>\s*/gi,
	/<think>[\s\S]*?<\/think>\s*/gi,
] as const;

// Pi clears old reasoning to an EMPTY thinking block (not "[cleared]"). Every Pi
// serializer drops empty thinking before the wire — anthropic.ts (empty thinking
// skipped), openai-completions.ts (filtered out of nonEmptyThinkingBlocks, with
// reasoning_content="" auto-filled for providers that require it), and
// amazon-bedrock.ts (empty thinking skipped). So an emptied block reaches NO
// provider, which structurally eliminates the stale-signature hazard that
// "[cleared]" + the original signature created on canonical Claude/Bedrock (a
// content/signature mismatch). The signature is dropped too since the block is
// discarded everywhere. This is intentionally DIFFERENT from OpenCode, whose
// non-Anthropic adapters forward empty parts, so OpenCode must keep "[cleared]"
// for canonical-anthropic-only and gate the write off elsewhere (see PARITY.md).
const CLEARED = "";

function stripInlineThinkingMarkup(text: string): string {
	let cleaned = text;
	for (const pattern of INLINE_THINKING_PATTERNS) {
		cleaned = cleaned.replace(pattern, "");
	}
	return cleaned;
}

/**
 * Build a `messageIdToTagNumber` map from the tagger's `targets` map
 * (returned by `tagTranscript`). For each message that has any tagged
 * part, record the MAX tag number across its parts — same contract
 * OpenCode's `messageTagNumbers` uses (see tag-messages.ts:209).
 *
 * Only text and tool tags are present in `targets`; thinking parts
 * are not tagged. That's fine: we only need the message's primary
 * tag to gate reasoning replay, and the primary tag always comes
 * from a text or tool part.
 */
export function buildMessageIdToMaxTag(
	targets: Map<number, TagTarget>,
): Map<string, number> {
	const out = new Map<string, number>();
	for (const [tagNumber, target] of targets) {
		const id = target.message?.info?.id;
		if (typeof id !== "string" || id.length === 0) continue;
		const prev = out.get(id) ?? 0;
		if (tagNumber > prev) out.set(id, tagNumber);
	}
	return out;
}

/**
 * Clear local typed reasoning on assistant messages whose tag number is older
 * than `(maxTag - clearReasoningAge)`. Returns the highest tag number that was
 * actually cleared, so the caller can persist the local watermark via
 * `setReasoningWatermark`.
 *
 * Mirrors OpenCode's `clearOldReasoning` (strip-content.ts).
 */
export function clearOldReasoningPi(args: {
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	clearReasoningAge: number;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): { cleared: number; newWatermark: number } {
	const { messages, messageIdToMaxTag, clearReasoningAge, piMessageStableId } =
		args;

	let maxTag = 0;
	for (const t of messageIdToMaxTag.values()) if (t > maxTag) maxTag = t;
	if (maxTag === 0) return { cleared: 0, newWatermark: 0 };

	const ageCutoff = maxTag - clearReasoningAge;
	if (ageCutoff <= 0) return { cleared: 0, newWatermark: 0 };

	let cleared = 0;
	let newWatermark = 0;

	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > ageCutoff) continue;

		let clearedThisMessage = false;
		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "thinking"
			) {
				const tp = part as PiThinkingContent;
				// Leave REDACTED thinking blocks untouched. Unlike normal thinking,
				// redacted blocks bypass the empty-drop in Pi's serializers
				// (transform-messages.ts and anthropic.ts serialize `redacted`
				// before the empty-thinking check), so emptying one + dropping its
				// signature would leave a malformed redacted block (no data, no sig)
				// on the wire. A redacted block carries no plaintext to save anyway;
				// keeping it verbatim is both safe and byte-stable across passes.
				if (tp.redacted) continue;
				// Empty the thinking AND drop its now-stale signature (a signature
				// over the original text would mismatch the emptied content). The
				// empty block is dropped by every Pi serializer, so neither reaches
				// the wire; dropping the sig keeps clear/replay producing identical
				// working-array state.
				if (tp.thinking !== CLEARED || tp.thinkingSignature !== undefined) {
					tp.thinking = CLEARED;
					tp.thinkingSignature = undefined;
					cleared++;
					clearedThisMessage = true;
				}
			}
		}
		if (clearedThisMessage && msgTag > newWatermark) {
			newWatermark = msgTag;
		}
	}

	return { cleared, newWatermark };
}

/**
 * Strip inline `<thinking>...</thinking>` and `<think>...</think>` markup
 * from assistant text content on execute passes. Returns the highest
 * message tag actually stripped so callers can persist it through
 * `setReasoningWatermark` and replay the same stripping on defer passes.
 */
export function stripInlineThinkingPi(args: {
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	clearReasoningAge: number;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): { stripped: number; newWatermark: number } {
	const { messages, messageIdToMaxTag, clearReasoningAge, piMessageStableId } =
		args;

	let maxTag = 0;
	for (const t of messageIdToMaxTag.values()) if (t > maxTag) maxTag = t;
	if (maxTag === 0) return { stripped: 0, newWatermark: 0 };

	const ageCutoff = maxTag - clearReasoningAge;
	if (ageCutoff <= 0) return { stripped: 0, newWatermark: 0 };

	let stripped = 0;
	let newWatermark = 0;

	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > ageCutoff) continue;

		let strippedThisMessage = false;
		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text"
			) {
				const tp = part as PiTextContent;
				if (typeof tp.text !== "string") continue;
				const cleaned = stripInlineThinkingMarkup(tp.text);
				if (cleaned !== tp.text) {
					tp.text = cleaned;
					stripped++;
					strippedThisMessage = true;
				}
			}
		}

		if (strippedThisMessage && msgTag > newWatermark) newWatermark = msgTag;
	}

	return { stripped, newWatermark };
}

/**
 * Replay local typed-reasoning clearing on EVERY pass (execute or defer).
 * Mirrors OpenCode's `replayClearedReasoning` — required for cache stability
 * so the Pi assistant content array stays byte-identical across passes.
 */
export function replayClearedReasoningPi(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): number {
	const { db, sessionId, messages, messageIdToMaxTag, piMessageStableId } =
		args;

	const meta = getOrCreateSessionMeta(db, sessionId);
	const watermark = meta.clearedReasoningThroughTag ?? 0;
	if (watermark <= 0) return 0;

	let cleared = 0;
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > watermark) continue;

		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "thinking"
			) {
				const tp = part as PiThinkingContent;
				// Mirror clearOldReasoningPi exactly: redacted blocks are left
				// untouched (they bypass the serializers' empty-drop, so emptying
				// one would put a malformed redacted block on the wire).
				if (tp.redacted) continue;
				// Replay the exact clear shape from clearOldReasoningPi: empty
				// thinking + dropped signature, so defer passes are byte-identical
				// to the cache-busting pass that set the watermark.
				if (tp.thinking !== CLEARED || tp.thinkingSignature !== undefined) {
					tp.thinking = CLEARED;
					tp.thinkingSignature = undefined;
					cleared++;
				}
			}
		}
	}
	return cleared;
}

/**
 * Replay inline `<thinking>...</thinking>` stripping on EVERY pass.
 * Mirrors OpenCode's `replayStrippedInlineThinking`. Some providers
 * (e.g. older Anthropic responses, Kimi non-interleaved) emit inline
 * thinking markup inside text content; once we strip it on an
 * execute pass via the same watermark, we must keep stripping on
 * every later pass to keep the prefix stable.
 */
export function replayStrippedInlineThinkingPi(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): number {
	const { db, sessionId, messages, messageIdToMaxTag, piMessageStableId } =
		args;

	const meta = getOrCreateSessionMeta(db, sessionId);
	const watermark = meta.clearedReasoningThroughTag ?? 0;
	if (watermark <= 0) return 0;

	let stripped = 0;
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > watermark) continue;

		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text"
			) {
				const tp = part as PiTextContent;
				if (typeof tp.text !== "string") continue;
				const cleaned = stripInlineThinkingMarkup(tp.text);
				if (cleaned !== tp.text) {
					tp.text = cleaned;
					stripped++;
				}
			}
		}
	}
	return stripped;
}

/**
 * @internal TEST-ONLY legacy index-id helper. NOT for production use.
 *
 * Production code resolves stable ids exclusively through
 * `resolvePiStableId` (read-session-pi.ts), which prefers the real
 * SessionEntry id and only falls back to this `pi-msg-<index>-...` format.
 * This standalone export produces ONLY the index-based fallback, which DRIFTS
 * when the visible array shifts — using it in production would reintroduce the
 * orphaned-state / cache-bust bug the unification fixed. It is retained solely
 * so the reasoning-replay unit tests can exercise the index-id shape directly.
 * Do not import it into production modules; reach for `resolvePiStableId`.
 */
export function piMessageStableId(
	msg: unknown,
	index: number,
): string | undefined {
	if (!msg || typeof msg !== "object") return undefined;
	const m = msg as { role?: string; timestamp?: number };
	const role = m.role ?? "unknown";
	if (typeof m.timestamp !== "number") return `pi-msg-${index}-${role}`;
	return `pi-msg-${index}-${m.timestamp}-${role}`;
}
