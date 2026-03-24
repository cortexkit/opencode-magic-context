import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { DreamingTask } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { extractLatestAssistantText } from "../../../tools/look-at/assistant-message-extractor";
import { acquireLease, getLeaseHolder, releaseLease, renewLease } from "./lease";
import { buildDreamTaskPrompt, DREAMER_SYSTEM_PROMPT } from "./task-prompts";
import { getDreamState, setDreamState } from "./storage-dream-state";

export interface DreamRunResult {
    startedAt: number;
    finishedAt: number;
    holderId: string;
    tasks: {
        name: string;
        durationMs: number;
        result: unknown;
        error?: string;
    }[];
}

export async function runDream(args: {
    db: Database;
    client: PluginContext["client"];
    projectPath: string;
    tasks: DreamingTask[];
    taskTimeoutMinutes: number;
    maxRuntimeMinutes: number;
    parentSessionId?: string;
    sessionDirectory?: string;
}): Promise<DreamRunResult> {
    const holderId = crypto.randomUUID();
    const startedAt = Date.now();
    const result: DreamRunResult = {
        startedAt,
        finishedAt: startedAt,
        holderId,
        tasks: [],
    };

    if (!acquireLease(args.db, holderId)) {
        result.tasks.push({
            name: "lease",
            durationMs: 0,
            result: null,
            error: `Dream lease is already held by ${getLeaseHolder(args.db) ?? "another holder"}`,
        });
        result.finishedAt = Date.now();
        return result;
    }

    const deadline = startedAt + args.maxRuntimeMinutes * 60 * 1000;
    const lastDreamAt = getDreamState(args.db, "last_dream_at");

    try {
        for (const taskName of args.tasks) {
            if (Date.now() > deadline) {
                break;
            }

            const taskStartedAt = Date.now();
            let agentSessionId: string | null = null;

            try {
                const existingDocs =
                    taskName === "maintain-docs"
                        ? {
                              architecture: existsSync(join(args.projectPath, "ARCHITECTURE.md")),
                              structure: existsSync(join(args.projectPath, "STRUCTURE.md")),
                          }
                        : undefined;

                const taskPrompt = buildDreamTaskPrompt(taskName, {
                    projectPath: args.projectPath,
                    lastDreamAt,
                    existingDocs,
                });

                const createResponse = await args.client.session.create({
                    body: {
                        ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
                        title: `magic-context-dream-${taskName}`,
                    },
                    query: { directory: args.sessionDirectory ?? args.projectPath },
                });

                const createdSession = shared.normalizeSDKResponse(
                    createResponse,
                    null as { id?: string } | null,
                    { preferResponseOnMissingData: true },
                );
                agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;
                if (!agentSessionId) {
                    throw new Error("Dreamer could not create its child session.");
                }

                await shared.promptSyncWithModelSuggestionRetry(
                    args.client,
                    {
                        path: { id: agentSessionId },
                        query: { directory: args.sessionDirectory ?? args.projectPath },
                        body: {
                            agent: DREAMER_AGENT,
                            system: DREAMER_SYSTEM_PROMPT,
                            parts: [{ type: "text", text: taskPrompt }],
                        },
                    },
                    { timeoutMs: args.taskTimeoutMinutes * 60 * 1000 },
                );

                const messagesResponse = await args.client.session.messages({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory ?? args.projectPath },
                });
                const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                    preferResponseOnMissingData: true,
                });
                const taskResult = extractLatestAssistantText(messages);
                if (!taskResult) {
                    throw new Error("Dreamer returned no assistant output.");
                }

                result.tasks.push({
                    name: taskName,
                    durationMs: Date.now() - taskStartedAt,
                    result: taskResult,
                });
            } catch (error) {
                result.tasks.push({
                    name: taskName,
                    durationMs: Date.now() - taskStartedAt,
                    result: null,
                    error: getErrorMessage(error),
                });
            } finally {
                if (agentSessionId) {
                    await args.client.session
                        .delete({
                            path: { id: agentSessionId },
                            query: { directory: args.sessionDirectory ?? args.projectPath },
                        })
                        .catch((error: unknown) => {
                            log("[dreamer] failed to delete child session:", error);
                        });
                }
            }

            if (!renewLease(args.db, holderId)) {
                log("[dreamer] lease renewal failed mid-run — lease may have expired");
            }
        }
    } finally {
        releaseLease(args.db, holderId);
    }

    result.finishedAt = Date.now();
    setDreamState(args.db, "last_dream_at", String(result.finishedAt));
    return result;
}
