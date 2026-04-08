import type { Database } from "bun:sqlite";
import { DEFAULT_HISTORIAN_TIMEOUT_MS } from "../../config/schema/magic-context";
import type { Compartment } from "../../features/magic-context/compartment-storage";
import {
    getAverageCompressionDepth,
    getCompartments,
    getMaxCompressionDepth,
    getSessionFacts,
    incrementCompressionDepth,
    replaceAllCompartmentState,
} from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { normalizeSDKResponse, promptSyncWithModelSuggestionRetry } from "../../shared";
import { extractLatestAssistantText } from "../../shared/assistant-message-extractor";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { parseCompartmentOutput } from "./compartment-parser";
import { buildCompressorPrompt } from "./compartment-prompt";
import { estimateTokens } from "./read-session-formatting";

const HISTORIAN_AGENT = "historian";

export interface CompressorDeps {
    client: PluginContext["client"];
    db: Database;
    sessionId: string;
    directory: string;
    historyBudgetTokens: number;
    historianTimeoutMs?: number;
}

/**
 * Check if the compartment block exceeds the history budget and run a compression pass if needed.
 * Returns true if compression ran successfully, false otherwise.
 */
export async function runCompressionPassIfNeeded(deps: CompressorDeps): Promise<boolean> {
    const { db, sessionId, historyBudgetTokens } = deps;

    const compartments = getCompartments(db, sessionId);
    if (compartments.length <= 1) return false;

    const facts = getSessionFacts(db, sessionId);

    // Estimate the current block size (compartments + facts, excluding memory block which is cached separately)
    let totalTokens = 0;
    for (const c of compartments) {
        // Rough estimate: title + content + XML overhead
        totalTokens += estimateTokens(
            `<compartment start="${c.startMessage}" end="${c.endMessage}" title="${c.title}">\n${c.content}\n</compartment>\n`,
        );
    }
    for (const f of facts) {
        totalTokens += estimateTokens(`* ${f.content}\n`);
    }

    if (totalTokens <= historyBudgetTokens) {
        sessionLog(
            sessionId,
            `compressor: history block ~${totalTokens} tokens within budget ${historyBudgetTokens}, skipping`,
        );
        return false;
    }

    const overage = totalTokens - historyBudgetTokens;
    sessionLog(
        sessionId,
        `compressor: history block ~${totalTokens} tokens exceeds budget ${historyBudgetTokens} by ~${overage} tokens`,
    );

    const maxDepth = getMaxCompressionDepth(db, sessionId);
    const scoredCompartments = compartments.map((compartment, index) => {
        const tokenEstimate = estimateTokens(
            `<compartment start="${compartment.startMessage}" end="${compartment.endMessage}" title="${compartment.title}">\n${compartment.content}\n</compartment>\n`,
        );
        const averageDepth = getAverageCompressionDepth(
            db,
            sessionId,
            compartment.startMessage,
            compartment.endMessage,
        );
        const normalizedAge = compartments.length > 1 ? 1 - index / (compartments.length - 1) : 1;
        const normalizedDepth = maxDepth > 0 ? 1 - averageDepth / maxDepth : 1;
        const score = 0.7 * normalizedAge + 0.3 * normalizedDepth;
        return {
            compartment,
            index,
            tokenEstimate,
            averageDepth,
            score,
        };
    });

    const sortedByScore = [...scoredCompartments].sort(
        (left, right) => right.score - left.score || left.index - right.index,
    );

    const targetSelectionTokens = overage * 2;
    let selectedCandidateTokens = 0;
    const selectedCandidates: typeof scoredCompartments = [];

    for (const compartment of sortedByScore) {
        if (selectedCandidateTokens >= targetSelectionTokens) break;
        selectedCandidates.push(compartment);
        selectedCandidateTokens += compartment.tokenEstimate;
    }

    if (selectedCandidates.length < 2) {
        sessionLog(sessionId, "compressor: not enough compartments to compress, skipping");
        return false;
    }

    const selectedStartIndex = Math.min(
        ...selectedCandidates.map((compartment) => compartment.index),
    );
    const selectedEndIndex = Math.max(
        ...selectedCandidates.map((compartment) => compartment.index),
    );
    let selectedScoredCompartments = scoredCompartments.slice(
        selectedStartIndex,
        selectedEndIndex + 1,
    );

    // Guard: if expanding to a contiguous range inflated tokens beyond 3× the
    // scored picks, fall back to the oldest contiguous subset of the scored picks.
    const expandedTokens = selectedScoredCompartments.reduce((t, c) => t + c.tokenEstimate, 0);
    if (expandedTokens > selectedCandidateTokens * 3) {
        const sortedByIndex = [...selectedCandidates].sort((a, b) => a.index - b.index);
        // Find longest contiguous run from the first scored pick
        let runEnd = sortedByIndex[0].index;
        for (let i = 1; i < sortedByIndex.length; i++) {
            if (sortedByIndex[i].index === runEnd + 1) {
                runEnd = sortedByIndex[i].index;
            } else {
                break;
            }
        }
        selectedScoredCompartments = scoredCompartments.slice(sortedByIndex[0].index, runEnd + 1);
        sessionLog(
            sessionId,
            `compressor: contiguous expansion was ${expandedTokens} tokens (>${selectedCandidateTokens * 3}), fell back to contiguous run of ${selectedScoredCompartments.length}`,
        );
    }

    if (selectedScoredCompartments.length < 2) {
        sessionLog(sessionId, "compressor: not enough adjacent compartments to compress, skipping");
        return false;
    }

    const selectedCompartments = selectedScoredCompartments.map(
        (scoredCompartment) => scoredCompartment.compartment,
    );
    const selectedTokens = selectedScoredCompartments.reduce(
        (total, scoredCompartment) => total + scoredCompartment.tokenEstimate,
        0,
    );
    const targetTokens = Math.floor(selectedTokens / 2);
    const minAverageDepth = Math.min(
        ...selectedScoredCompartments.map((compartment) => compartment.averageDepth),
    );
    const maxAverageDepth = Math.max(
        ...selectedScoredCompartments.map((compartment) => compartment.averageDepth),
    );
    const minScore = Math.min(
        ...selectedScoredCompartments.map((compartment) => compartment.score),
    );
    const maxScore = Math.max(
        ...selectedScoredCompartments.map((compartment) => compartment.score),
    );

    sessionLog(
        sessionId,
        `compressor: scored ${compartments.length} compartments, selected ${selectedCompartments.length} (avg_depth range: ${minAverageDepth.toFixed(1)}-${maxAverageDepth.toFixed(1)}, score range: ${minScore.toFixed(1)}-${maxScore.toFixed(1)})`,
    );
    // Compute overall average depth for the selected range (used for U: line handling)
    const overallAverageDepth =
        selectedScoredCompartments.reduce((sum, c) => sum + c.averageDepth, 0) /
        selectedScoredCompartments.length;
    const depthTier =
        overallAverageDepth < 2
            ? "preserve U: lines"
            : overallAverageDepth < 3
              ? "condense U: lines"
              : "fold U: into prose";

    sessionLog(
        sessionId,
        `compressor: selected contiguous range ${selectedCompartments[0].startMessage}-${selectedCompartments[selectedCompartments.length - 1].endMessage} (~${selectedTokens} tokens), target ~${targetTokens} tokens, avg_depth=${overallAverageDepth.toFixed(1)} (${depthTier})`,
    );

    try {
        const compressed = await runCompressorPass({
            ...deps,
            compartments: selectedCompartments,
            currentTokens: selectedTokens,
            targetTokens,
            averageDepth: overallAverageDepth,
        });

        if (!compressed) {
            sessionLog(
                sessionId,
                "compressor: compression pass failed, keeping existing compartments",
            );
            return false;
        }

        // Replace the selected compartments with compressed ones, keep the rest unchanged
        const leadingCompartments = compartments.slice(0, selectedStartIndex);
        const trailingCompartments = compartments.slice(selectedEndIndex + 1);
        const allCompartments = [
            ...leadingCompartments.map((c, i) => ({
                sequence: i,
                startMessage: c.startMessage,
                endMessage: c.endMessage,
                startMessageId: c.startMessageId,
                endMessageId: c.endMessageId,
                title: c.title,
                content: c.content,
            })),
            ...compressed.map((c, i) => ({
                sequence: leadingCompartments.length + i,
                startMessage: c.startMessage,
                endMessage: c.endMessage,
                startMessageId: c.startMessageId,
                endMessageId: c.endMessageId,
                title: c.title,
                content: c.content,
            })),
            ...trailingCompartments.map((c, i) => ({
                sequence: leadingCompartments.length + compressed.length + i,
                startMessage: c.startMessage,
                endMessage: c.endMessage,
                startMessageId: c.startMessageId,
                endMessageId: c.endMessageId,
                title: c.title,
                content: c.content,
            })),
        ];

        // Validate: compressed compartments must cover same range as originals
        const originalStart = selectedCompartments[0].startMessage;
        const originalEnd = selectedCompartments[selectedCompartments.length - 1].endMessage;
        const compressedStart = compressed[0].startMessage;
        const compressedEnd = compressed[compressed.length - 1].endMessage;

        if (compressedStart !== originalStart || compressedEnd !== originalEnd) {
            sessionLog(
                sessionId,
                `compressor: compressed range ${compressedStart}-${compressedEnd} doesn't match original ${originalStart}-${originalEnd}, aborting`,
            );
            return false;
        }

        // Validate internal contiguity: no gaps or overlaps between compressed compartments
        for (let i = 1; i < compressed.length; i++) {
            const prev = compressed[i - 1];
            const curr = compressed[i];
            if (curr.startMessage <= prev.endMessage) {
                sessionLog(
                    sessionId,
                    `compressor: overlap at compartment ${i}: prev ends ${prev.endMessage}, curr starts ${curr.startMessage}, aborting`,
                );
                return false;
            }
            if (curr.startMessage > prev.endMessage + 1) {
                sessionLog(
                    sessionId,
                    `compressor: gap at compartment ${i}: prev ends ${prev.endMessage}, curr starts ${curr.startMessage}, aborting`,
                );
                return false;
            }
        }

        // Persist: replace compartments only, keep facts as-is
        replaceAllCompartmentState(
            db,
            sessionId,
            allCompartments,
            facts.map((f) => ({ category: f.category, content: f.content })),
        );
        // Do NOT call clearInjectionCache here. The compressor may run in the
        // background (fire-and-forget from the independent compressor path).
        // Clearing the in-memory injection cache would cause the next defer pass
        // to rebuild <session-history> with the new compressed compartments,
        // producing different message[0] content and busting the LLM cache.
        // Instead, let the stale in-memory cache persist. The next natural
        // cache-busting pass (isCacheBusting=true) always bypasses the cache
        // and reads fresh from DB, automatically picking up the compression.
        incrementCompressionDepth(db, sessionId, originalStart, originalEnd);

        sessionLog(
            sessionId,
            `compressor: replaced ${selectedCompartments.length} compartments with ${compressed.length} compressed compartments`,
        );
        sessionLog(
            sessionId,
            `compressor: incremented compression depth for messages ${originalStart}-${originalEnd}`,
        );
        return true;
    } catch (error: unknown) {
        sessionLog(sessionId, "compressor: unexpected error:", getErrorMessage(error));
        return false;
    }
}

interface CompressorPassArgs {
    client: PluginContext["client"];
    sessionId: string;
    directory: string;
    compartments: Compartment[];
    currentTokens: number;
    targetTokens: number;
    averageDepth: number;
    historianTimeoutMs?: number;
}

async function runCompressorPass(args: CompressorPassArgs): Promise<Array<{
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    content: string;
}> | null> {
    const {
        client,
        sessionId,
        directory,
        compartments,
        currentTokens,
        targetTokens,
        averageDepth,
        historianTimeoutMs,
    } = args;

    const prompt = buildCompressorPrompt(compartments, currentTokens, targetTokens, averageDepth);

    let agentSessionId: string | null = null;
    try {
        const createResponse = await client.session.create({
            body: {
                parentID: sessionId,
                title: "magic-context-compressor",
            },
            query: { directory },
        });

        const createdSession = normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;

        if (!agentSessionId) {
            sessionLog(sessionId, "compressor: could not create child session");
            return null;
        }

        await promptSyncWithModelSuggestionRetry(
            client,
            {
                path: { id: agentSessionId },
                query: { directory },
                body: {
                    agent: HISTORIAN_AGENT,
                    parts: [{ type: "text", text: prompt }],
                },
            },
            { timeoutMs: historianTimeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS },
        );

        const messagesResponse = await client.session.messages({
            path: { id: agentSessionId },
            query: { directory },
        });
        const messages = normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        const result = extractLatestAssistantText(messages);
        if (!result) {
            sessionLog(sessionId, "compressor: historian returned no output");
            return null;
        }

        const parsed = parseCompartmentOutput(result);
        if (parsed.compartments.length === 0) {
            sessionLog(sessionId, "compressor: historian returned no compartments");
            return null;
        }

        // Build a lookup for message IDs from original compartments
        const messageIdMap = new Map<number, string>();
        for (const c of compartments) {
            messageIdMap.set(c.startMessage, c.startMessageId);
            messageIdMap.set(c.endMessage, c.endMessageId);
        }

        // Map parsed compartments to stored format with message IDs
        const mapped = parsed.compartments.map((pc) => {
            const startId = messageIdMap.get(pc.startMessage) ?? "";
            const endId = messageIdMap.get(pc.endMessage) ?? "";
            if (!startId || !endId) {
                sessionLog(
                    sessionId,
                    `compressor: messageId miss for ordinals ${pc.startMessage}→${pc.endMessage} (startId=${startId || "MISSING"}, endId=${endId || "MISSING"})`,
                );
            }
            return {
                startMessage: pc.startMessage,
                endMessage: pc.endMessage,
                startMessageId: startId,
                endMessageId: endId,
                title: pc.title,
                content: pc.content,
            };
        });

        // Reject if any compartment has empty messageIds — the compressor introduced
        // boundaries we can't anchor. Empty interior IDs cause silent data degradation,
        // and an empty final endMessageId breaks visible-prefix trimming.
        const hasEmptyIds = mapped.some((c) => !c.startMessageId || !c.endMessageId);
        if (hasEmptyIds) {
            sessionLog(
                sessionId,
                "compressor: rejecting — one or more compartments have empty messageIds",
            );
            return null;
        }

        return mapped;
    } catch (error: unknown) {
        sessionLog(sessionId, "compressor: historian call failed:", getErrorMessage(error));
        return null;
    } finally {
        if (agentSessionId) {
            await client.session
                .delete({ path: { id: agentSessionId }, query: { directory } })
                .catch((e: unknown) => {
                    sessionLog(
                        sessionId,
                        "compressor: session cleanup failed:",
                        getErrorMessage(e),
                    );
                });
        }
    }
}
