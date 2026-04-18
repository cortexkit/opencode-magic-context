import { isRecord } from "../../shared/record-type-guard";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";

const DROPPED_PLACEHOLDER_PATTERN = /^\[dropped §\d+§\]$/;
const TAG_PREFIX_PATTERN = /^§\d+§\s*/;

// Patterns that identify system-injected messages (notifications, reminders, etc.)
// These should never reach the LLM — they're internal plumbing.
const SYSTEM_INJECTION_PATTERNS = [
    /^<!-- OMO_INTERNAL_INITIATOR -->$/,
    /^<system-reminder>[\s\S]*<\/system-reminder>$/,
    /^\[SYSTEM DIRECTIVE:/,
    /^\[Category\+Skill Reminder\]/,
    /^\[EDIT ERROR - IMMEDIATE ACTION REQUIRED\]/,
    /^\[task CALL FAILED/,
    /^\[EMERGENCY CONTEXT WINDOW WARNING\]/,
];

function isSystemInjectedText(text: string): boolean {
    // Remove §N§ tag prefix that our tagger adds
    const stripped = text.trim().replace(TAG_PREFIX_PATTERN, "").trim();
    if (stripped.length === 0) return false;
    return SYSTEM_INJECTION_PATTERNS.some((pattern) => pattern.test(stripped));
}

/**
 * Remove messages that are system-injected (notifications, reminders, internal markers).
 * These are internal plumbing messages that should never reach the LLM.
 * Only strips messages BEFORE `protectedTailStart` — recent messages in the
 * protected tail may contain actionable info (e.g., background task completion
 * notifications with task IDs the agent needs for background_output).
 */
export function stripSystemInjectedMessages(
    messages: MessageLike[],
    protectedTailStart: number,
): number {
    let stripped = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        // Don't strip messages in the protected tail — they may contain
        // actionable info like background task IDs
        if (i >= protectedTailStart) continue;

        const msg = messages[i];
        if (msg.parts.length === 0) continue;

        let hasContentPart = false;
        let allContentIsSystemInjection = true;

        for (const part of msg.parts) {
            if (!isRecord(part)) continue;
            const partType = part.type as string;

            // Skip metadata parts
            if (METADATA_PART_TYPES.has(partType)) continue;

            // Check for ignored flag (set by sendIgnoredMessage)
            if (part.ignored === true) continue;

            // Tool parts are real content
            if (partType === "tool") {
                allContentIsSystemInjection = false;
                break;
            }

            if (partType === "text" && typeof part.text === "string") {
                hasContentPart = true;
                if (!isSystemInjectedText(part.text)) {
                    allContentIsSystemInjection = false;
                    break;
                }
                continue;
            }

            // Any other content type — keep the message
            allContentIsSystemInjection = false;
            break;
        }

        if (hasContentPart && allContentIsSystemInjection) {
            messages.splice(i, 1);
            stripped++;
        }
    }
    return stripped;
}

// OpenCode messages can have metadata parts alongside content parts.
// Only text/reasoning/tool/file parts carry content to the model — metadata
// parts are invisible to the LLM. We skip these when deciding if a message
// is nothing but dropped placeholders.
//
// NOTE: `file` is NOT in this set because file parts carry real content
// (pasted images, attached documents, etc.) that reaches the model via a
// provider-specific content block. Treating a file part as metadata would
// risk stripping an image-bearing message if its text part became a dropped
// placeholder, silently destroying the user's visual context.
const METADATA_PART_TYPES = new Set([
    "step-start",
    "step-finish",
    "snapshot",
    "patch",
    "agent",
    "retry",
    "subtask",
    "compaction",
]);

/**
 * Remove messages that consist entirely of [dropped §N§] placeholders.
 * These are leftover shells after ctx_reduce drops their content — keeping them
 * wastes tokens without providing any value since there is no recall mechanism.
 *
 * User-role messages are NEVER stripped, even if their only text is a dropped
 * placeholder. Removing a user message between two assistants collapses the
 * turn boundary, which causes the AI SDK's Anthropic adapter to merge
 * consecutive assistants into a single "latest assistant" block containing
 * signed thinking. The merged block's signature no longer matches the
 * original, triggering:
 *   "thinking or redacted_thinking blocks in the latest assistant message
 *    cannot be modified"
 *
 * For user messages whose content the agent wanted to drop, apply-operations
 * emits a `[truncated §N§]` preview instead of a full `[dropped §N§]`, which
 * keeps the shell visible and preserves the turn boundary.
 */
export function stripDroppedPlaceholderMessages(messages: MessageLike[]): number {
    let stripped = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.parts.length === 0) continue;

        // Never strip user-role messages — they anchor turn boundaries that
        // AI SDK depends on to avoid merging consecutive assistants.
        if (msg.info.role === "user") continue;

        let hasContentPart = false;
        let hasNonDroppedContent = false;

        for (const part of msg.parts) {
            if (!isRecord(part)) continue;
            const partType = part.type as string;

            // Skip metadata parts — they don't reach the model
            if (METADATA_PART_TYPES.has(partType)) continue;

            // Tool parts carry content — don't strip messages with tool calls/results
            if (partType === "tool") {
                hasNonDroppedContent = true;
                break;
            }

            // Text parts: check if they're only dropped placeholders
            if (partType === "text" && typeof part.text === "string") {
                hasContentPart = true;
                const trimmed = part.text.trim();
                if (trimmed.length === 0) continue;
                const allSegmentsDropped = trimmed
                    .split(/(?=\[dropped §)/)
                    .filter((s) => s.trim().length > 0)
                    .every((segment) => DROPPED_PLACEHOLDER_PATTERN.test(segment.trim()));
                if (!allSegmentsDropped) {
                    hasNonDroppedContent = true;
                    break;
                }
                continue;
            }

            // Reasoning parts: check similarly
            if (partType === "reasoning" && typeof part.text === "string") {
                hasContentPart = true;
                const trimmed = part.text.trim();
                if (trimmed.length === 0) continue;
                const allSegmentsDropped = trimmed
                    .split(/(?=\[dropped §)/)
                    .filter((s) => s.trim().length > 0)
                    .every((segment) => DROPPED_PLACEHOLDER_PATTERN.test(segment.trim()));
                if (!allSegmentsDropped) {
                    hasNonDroppedContent = true;
                    break;
                }
                continue;
            }

            // Unknown content-carrying part type — don't strip
            hasNonDroppedContent = true;
            break;
        }

        if (hasContentPart && !hasNonDroppedContent) {
            messages.splice(i, 1);
            stripped++;
        }
    }
    return stripped;
}

/**
 * Replay persisted reasoning clearing on every pass (including defer).
 * Clears reasoning for all messages with tag <= persistedWatermark.
 * This ensures clearing is sticky across passes even when OpenCode
 * rebuilds messages fresh from its own DB.
 */
export function replayClearedReasoning(
    messages: MessageLike[],
    reasoningByMessage: Map<MessageLike, ThinkingLikePart[]>,
    messageTagNumbers: Map<MessageLike, number>,
    persistedWatermark: number,
): number {
    if (persistedWatermark <= 0) return 0;

    let cleared = 0;
    for (const message of messages) {
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > persistedWatermark) continue;

        const parts = reasoningByMessage.get(message);
        if (!parts) continue;

        for (const tp of parts) {
            if (tp.thinking !== undefined && tp.thinking !== "[cleared]") {
                tp.thinking = "[cleared]";
                cleared++;
            }
            if (tp.text !== undefined && tp.text !== "[cleared]") {
                tp.text = "[cleared]";
                cleared++;
            }
        }
    }
    return cleared;
}

/**
 * Replay persisted inline thinking stripping on every pass (including defer).
 * Strips inline <thinking> tags for all messages with tag <= persistedWatermark.
 */
export function replayStrippedInlineThinking(
    messages: MessageLike[],
    messageTagNumbers: Map<MessageLike, number>,
    persistedWatermark: number,
): number {
    if (persistedWatermark <= 0) return 0;

    let stripped = 0;
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > persistedWatermark) continue;

        for (const part of message.parts) {
            if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
            const cleaned = (part.text as string).replace(INLINE_THINKING_PATTERN, "");
            if (cleaned !== part.text) {
                part.text = cleaned;
                stripped++;
            }
        }
    }
    return stripped;
}

export function clearOldReasoning(
    messages: MessageLike[],
    reasoningByMessage: Map<MessageLike, ThinkingLikePart[]>,
    messageTagNumbers: Map<MessageLike, number>,
    clearReasoningAge: number,
): number {
    const maxTag = findMaxTag(messageTagNumbers);
    if (maxTag === 0) return 0;

    const ageCutoff = maxTag - clearReasoningAge;
    let cleared = 0;

    for (const message of messages) {
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > ageCutoff) continue;

        const parts = reasoningByMessage.get(message);
        if (!parts) continue;

        for (const tp of parts) {
            if (tp.thinking !== undefined && tp.thinking !== "[cleared]") {
                tp.thinking = "[cleared]";
                cleared++;
            }
            if (tp.text !== undefined && tp.text !== "[cleared]") {
                tp.text = "[cleared]";
                cleared++;
            }
        }
    }

    return cleared;
}

function findMaxTag(messageTagNumbers: Map<MessageLike, number>): number {
    let max = 0;
    for (const tag of messageTagNumbers.values()) {
        if (tag > max) max = tag;
    }
    return max;
}

const CLEARED_REASONING_TYPES = new Set(["thinking", "reasoning"]);

export function stripClearedReasoning(messages: MessageLike[]): number {
    let stripped = 0;
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const originalLength = message.parts.length;
        const kept = message.parts.filter((part) => {
            if (!isRecord(part)) return true;
            const partType = part.type as string;
            if (!CLEARED_REASONING_TYPES.has(partType)) return true;
            // Defense-in-depth: if neither `thinking` nor `text` is present on
            // the part, we cannot tell whether it's a cleared shell — keep it.
            // This protects edge-case thinking shapes (e.g., future providers
            // emitting parts with only a `data` or `signature` field) from
            // being wrongly dropped. Anthropic requires thinking-like blocks in
            // the latest assistant message to be replayed unchanged, and an
            // undefined-fields part cannot be known to be cleared, so it is
            // not safe to strip it.
            if (!("thinking" in part) && !("text" in part)) return true;
            const thinking = "thinking" in part ? (part.thinking as string | undefined) : undefined;
            const text = "text" in part ? (part.text as string | undefined) : undefined;
            return (
                (thinking !== undefined && thinking !== "[cleared]") ||
                (text !== undefined && text !== "[cleared]")
            );
        });
        if (kept.length < originalLength) {
            message.parts.length = 0;
            message.parts.push(...kept);
            stripped += originalLength - kept.length;
        }
    }
    return stripped;
}

const INLINE_THINKING_PATTERN = /<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g;

export function stripInlineThinking(
    messages: MessageLike[],
    messageTagNumbers: Map<MessageLike, number>,
    clearReasoningAge: number,
): number {
    const maxTag = findMaxTag(messageTagNumbers);
    if (maxTag === 0) return 0;

    const ageCutoff = maxTag - clearReasoningAge;
    let stripped = 0;

    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > ageCutoff) continue;

        for (const part of message.parts) {
            if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
            const cleaned = (part.text as string).replace(INLINE_THINKING_PATTERN, "");
            if (cleaned !== part.text) {
                part.text = cleaned;
                stripped++;
            }
        }
    }
    return stripped;
}

export function truncateErroredTools(
    messages: MessageLike[],
    watermark: number,
    messageTagNumbers: Map<MessageLike, number>,
): number {
    let truncated = 0;
    for (let i = 0; i < messages.length; i++) {
        const maxTag = messageTagNumbers.get(messages[i]) ?? 0;
        if (maxTag > watermark) {
            continue;
        }

        for (const part of messages[i].parts) {
            if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) {
                continue;
            }
            if (part.state.status !== "error") {
                continue;
            }
            if (typeof part.state.error === "string" && part.state.error.length > 100) {
                part.state.error = `${part.state.error.slice(0, 100)}... [truncated]`;
                truncated++;
            }
        }
    }
    return truncated;
}

/**
 * Work around @ai-sdk/anthropic's groupIntoBlocks behavior. When multiple
 * consecutive OpenCode assistant messages (each carrying its own signed
 * reasoning part) are sent to the Anthropic provider, the SDK merges them
 * into a single Anthropic assistant block with thinking blocks INTERLEAVED
 * between text blocks — e.g. [thinking, text, thinking, text, thinking, text].
 *
 * Claude Opus 4.7's server-side validation rejects this layout with:
 *   "thinking or redacted_thinking blocks in the latest assistant message
 *    cannot be modified. These blocks must remain as they were in the
 *    original response."
 *
 * The only safe layout is thinking blocks at the START of the merged
 * assistant block. We strip reasoning parts from every assistant except the
 * first in each consecutive assistant run. After AI SDK merges the run, the
 * assistant content becomes [thinking, text, text, tool_use, text, …] — valid.
 *
 * Trade-off: the model loses visibility into its own intermediate step
 * reasoning for earlier steps of a multi-step turn. The first step's reasoning
 * is preserved, which carries enough cache continuity for Anthropic.
 *
 * This is an upstream bug in @ai-sdk/anthropic's `groupIntoBlocks`:
 *   https://github.com/vercel/ai/blob/main/packages/anthropic/src/
 *     convert-to-anthropic-messages-prompt.ts  (case 'assistant')
 * Same class of bug was fixed for Bedrock in vercel/ai#13583/#13972.
 */
export function stripReasoningFromMergedAssistants(messages: MessageLike[]): number {
    let stripped = 0;
    let prevRole: string | undefined;

    for (const message of messages) {
        const role = message.info.role;
        if (role === "assistant" && prevRole === "assistant") {
            // Not the first of a consecutive assistant run — strip reasoning.
            for (let i = message.parts.length - 1; i >= 0; i--) {
                const part = message.parts[i];
                if (!isRecord(part)) continue;
                const partType = part.type as string;
                if (partType === "reasoning") {
                    message.parts.splice(i, 1);
                    stripped++;
                }
            }
        }
        prevRole = role;
    }

    return stripped;
}

export function stripProcessedImages(
    messages: MessageLike[],
    watermark: number,
    messageTagNumbers: Map<MessageLike, number>,
): number {
    let stripped = 0;
    let hasAssistantResponse = false;

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role === "assistant") {
            hasAssistantResponse = true;
            continue;
        }
        if (msg.info.role !== "user" || !hasAssistantResponse) {
            continue;
        }

        const maxTag = messageTagNumbers.get(msg) ?? 0;
        if (maxTag > watermark) {
            continue;
        }

        for (let j = msg.parts.length - 1; j >= 0; j--) {
            const part = msg.parts[j];
            if (!isRecord(part) || part.type !== "file") {
                continue;
            }
            if (typeof part.mime !== "string" || !part.mime.startsWith("image/")) {
                continue;
            }
            if (
                typeof part.url === "string" &&
                part.url.startsWith("data:") &&
                part.url.length > 200
            ) {
                msg.parts.splice(j, 1);
                stripped++;
            }
        }
    }

    return stripped;
}
