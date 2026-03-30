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
    ctxReduceEnabled: boolean;
    flushedSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
}): (input: { sessionID?: string }, output: { system: string[] }) => Promise<void> {
    // Per-session sticky date: we freeze the date string from the system prompt
    // and only update it on cache-busting passes. This prevents a midnight date
    // flip from causing an unnecessary flush + cache rebuild.
    const stickyDateBySession = new Map<string, string>();

    return async (input, output): Promise<void> => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        // ── Step 1: Inject magic-context guidance ──
        const fullPrompt = output.system.join("\n");
        if (fullPrompt.length > 0 && !fullPrompt.includes(MAGIC_CONTEXT_MARKER)) {
            const detectedAgent = detectAgentFromSystemPrompt(fullPrompt);
            const guidance = buildMagicContextSection(
                detectedAgent,
                deps.protectedTags,
                deps.ctxReduceEnabled,
            );
            output.system.push(guidance);
            sessionLog(
                sessionId,
                `injected ${detectedAgent ?? "generic"} guidance into system prompt`,
            );
        }

        // ── Step 2: Freeze volatile date to prevent unnecessary cache busts ──
        const isCacheBusting = deps.flushedSessions.has(sessionId);
        const DATE_PATTERN = /Today's date: .+/;

        for (let i = 0; i < output.system.length; i++) {
            const match = output.system[i].match(DATE_PATTERN);
            if (!match) continue;

            const currentDate = match[0];
            const stickyDate = stickyDateBySession.get(sessionId);

            if (!stickyDate) {
                // First time seeing this session — store the date
                stickyDateBySession.set(sessionId, currentDate);
            } else if (currentDate !== stickyDate) {
                if (isCacheBusting) {
                    // Cache is already busting — update to the real date
                    stickyDateBySession.set(sessionId, currentDate);
                    sessionLog(
                        sessionId,
                        `system prompt date updated: ${stickyDate} → ${currentDate} (cache-busting pass)`,
                    );
                } else {
                    // Defer pass — replace with the sticky date to keep prompt stable
                    output.system[i] = output.system[i].replace(DATE_PATTERN, stickyDate);
                    sessionLog(
                        sessionId,
                        `system prompt date frozen: real=${currentDate}, using=${stickyDate} (defer pass)`,
                    );
                }
            }
            break;
        }

        // ── Step 3: Detect system prompt changes ──
        const systemContent = output.system.join("\n");
        if (systemContent.length === 0) return;

        // Use hex digest — numeric strings get coerced by SQLite INTEGER column affinity,
        // causing precision loss on read-back and infinite hash-change flushes.
        const currentHash = new Bun.CryptoHasher("md5").update(systemContent).digest("hex");

        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            sessionMeta = getOrCreateSessionMeta(deps.db, sessionId);
        } catch (error) {
            sessionLog(sessionId, "system-prompt-hash DB update failed:", error);
            return;
        }

        const previousHash = sessionMeta.systemPromptHash;
        if (previousHash !== "" && previousHash !== "0" && previousHash !== currentHash) {
            sessionLog(
                sessionId,
                `system prompt hash changed: ${previousHash} → ${currentHash} (len=${systemContent.length}), triggering flush`,
            );
            deps.flushedSessions.add(sessionId);
            deps.lastHeuristicsTurnId.delete(sessionId);
        } else if (previousHash === "" || previousHash === "0") {
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
