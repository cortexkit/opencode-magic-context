import {
    buildMagicContextSection,
    detectAgentFromSystemPrompt,
} from "../../agents/magic-context-prompt";
import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { sessionLog } from "../../shared/logger";

const MAGIC_CONTEXT_MARKER = "## Magic Context";

/**
 * Handle system prompt via experimental.chat.system.transform:
 *
 * 1. Inject per-agent magic-context guidance into the system prompt.
 *    Detects known agents (Sisyphus, Atlas, etc.) from prompt content and
 *    injects tailored reduction guidance. Falls back to generic guidance
 *    for unknown agents. Skips injection if guidance is already present
 *    (e.g., baked into the agent prompt by oh-my-opencode).
 *
 * 2. Detect system prompt changes for cache-flush triggering.
 *    If the hash changes between turns, the Anthropic prompt-cache prefix is
 *    already busted, so we flush queued operations immediately.
 */
export function createSystemPromptHashHandler(deps: {
    db: ContextDatabase;
    protectedTags: number;
    flushedSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
}): (input: { sessionID?: string }, output: { system: string[] }) => Promise<void> {
    return async (input, output): Promise<void> => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        // ── Step 1: Inject magic-context guidance ──
        const fullPrompt = output.system.join("\n");
        if (fullPrompt.length > 0 && !fullPrompt.includes(MAGIC_CONTEXT_MARKER)) {
            const detectedAgent = detectAgentFromSystemPrompt(fullPrompt);
            const guidance = buildMagicContextSection(detectedAgent, deps.protectedTags);
            output.system.push(guidance);
            sessionLog(
                sessionId,
                `injected ${detectedAgent ?? "generic"} guidance into system prompt`,
            );
        }

        // ── Step 2: Detect system prompt changes ──
        const systemContent = output.system.join("\n");
        if (systemContent.length === 0) return;

        const currentHash = Number(Bun.hash(systemContent));

        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            sessionMeta = getOrCreateSessionMeta(deps.db, sessionId);
        } catch (error) {
            sessionLog(sessionId, "system-prompt-hash DB update failed:", error);
            return;
        }

        const previousHash = sessionMeta.systemPromptHash;
        if (previousHash !== 0 && previousHash !== currentHash) {
            sessionLog(
                sessionId,
                `system prompt hash changed: ${previousHash} → ${currentHash} (len=${systemContent.length}), triggering flush`,
            );
            deps.flushedSessions.add(sessionId);
            // NOTE: Do NOT clear lastHeuristicsTurnId here. The system transform
            // also fires during /dump-context (a read-only operation) and we cannot
            // distinguish dump from live chat. Clearing the heuristic guard would let
            // the messages transform re-execute heuristic cleanup on the same user turn,
            // causing unintended drops during dumps. The flush flag alone is sufficient;
            // the messages transform will run heuristics on the next real user turn.
        } else if (previousHash === 0) {
            sessionLog(
                sessionId,
                `system prompt hash initialized: ${currentHash} (len=${systemContent.length})`,
            );
        }

        if (currentHash !== previousHash) {
            updateSessionMeta(deps.db, sessionId, { systemPromptHash: currentHash });
        }
    };
}
