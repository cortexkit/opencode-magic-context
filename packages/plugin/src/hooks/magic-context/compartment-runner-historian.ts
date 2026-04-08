import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORIAN_AGENT } from "../../agents/historian";
import { DEFAULT_HISTORIAN_TIMEOUT_MS } from "../../config/schema/magic-context";
import type { PluginContext } from "../../plugin/types";
import * as shared from "../../shared";
import { extractLatestAssistantText } from "../../shared/assistant-message-extractor";
import { getErrorMessage } from "../../shared/error-message";
import type {
    HistorianProgressCallbacks,
    HistorianRunResult,
    StoredCompartmentRange,
    ValidatedHistorianPassResult,
} from "./compartment-runner-types";
import {
    buildHistorianRepairPrompt,
    validateHistorianOutput,
} from "./compartment-runner-validation";

// Intentionally kept: historian validation failure dumps are preserved for debugging.
// These are written to /tmp and survive until manual cleanup or OS temp pruning.
// The user has explicitly requested keeping these dumps for now (see audit #21).
const HISTORIAN_RESPONSE_DUMP_DIR = join(tmpdir(), "magic-context-historian");
const MAX_HISTORIAN_RETRIES = 2;

interface HistorianModelOverride {
    providerID: string;
    modelID: string;
}

export async function runValidatedHistorianPass(args: {
    client: PluginContext["client"];
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
    };
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    dumpLabelBase: string;
    timeoutMs?: number;
    fallbackModelId?: string;
    callbacks?: HistorianProgressCallbacks;
}): Promise<ValidatedHistorianPassResult> {
    const firstRun = await runHistorianPrompt({
        ...args,
        dumpLabel: `${args.dumpLabelBase}-initial`,
    });
    if (!firstRun.ok || !firstRun.result) {
        return runFallbackHistorianPass({
            ...args,
            prompt: args.prompt,
            error: firstRun.error ?? "historian run failed",
            dumpPaths: [firstRun.dumpPath],
        });
    }

    const firstValidation = validateHistorianOutput(
        firstRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (firstValidation.ok) {
        cleanupHistorianDump(args.parentSessionId, firstRun.dumpPath);
        return firstValidation;
    }

    await args.callbacks?.onRepairRetry?.(firstValidation.error ?? "invalid compartment output");
    const repairPrompt = buildHistorianRepairPrompt(
        args.prompt,
        firstRun.result,
        firstValidation.error ?? "invalid compartment output",
    );
    const repairRun = await runHistorianPrompt({
        ...args,
        prompt: repairPrompt,
        dumpLabel: `${args.dumpLabelBase}-repair`,
    });
    if (!repairRun.ok || !repairRun.result) {
        return runFallbackHistorianPass({
            ...args,
            prompt: repairPrompt,
            error: repairRun.error ?? "historian repair run failed",
            dumpPaths: [firstRun.dumpPath, repairRun.dumpPath],
        });
    }

    const repairValidation = validateHistorianOutput(
        repairRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (repairValidation.ok) {
        // Keep firstRun.dumpPath (initial failure) for debugging.
        // Only cleanup the successful repair run's dump.
        cleanupHistorianDump(args.parentSessionId, repairRun.dumpPath);
        return repairValidation;
    }

    return runFallbackHistorianPass({
        ...args,
        prompt: repairPrompt,
        error: repairValidation.error ?? "invalid compartment output",
        dumpPaths: [firstRun.dumpPath, repairRun.dumpPath],
    });
}

async function runHistorianPrompt(args: {
    client: PluginContext["client"];
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    timeoutMs?: number;
    dumpLabel?: string;
    modelOverride?: HistorianModelOverride;
}): Promise<HistorianRunResult> {
    const {
        client,
        parentSessionId,
        sessionDirectory,
        prompt,
        timeoutMs,
        dumpLabel,
        modelOverride,
    } = args;
    let agentSessionId: string | null = null;

    try {
        shared.sessionLog(
            parentSessionId,
            `historian: creating child session (model=${modelOverride ? `${modelOverride.providerID}/${modelOverride.modelID}` : `agent:${HISTORIAN_AGENT}`})`,
        );
        const createResponse = await client.session.create({
            body: {
                parentID: parentSessionId,
                title: "magic-context-compartment",
            },
            query: { directory: sessionDirectory },
        });

        const createdSession = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;

        if (!agentSessionId) {
            return { ok: false, error: "Historian could not create its child session." };
        }

        for (let retryIndex = 0; retryIndex <= MAX_HISTORIAN_RETRIES; retryIndex += 1) {
            try {
                await shared.promptSyncWithModelSuggestionRetry(
                    client,
                    {
                        path: { id: agentSessionId },
                        query: { directory: sessionDirectory },
                        body: {
                            // Always use the historian agent for its system prompt.
                            // When modelOverride is set, OpenCode uses the override model
                            // but still loads the historian agent's registered system prompt.
                            agent: HISTORIAN_AGENT,
                            ...(modelOverride ? { model: modelOverride } : {}),
                            parts: [{ type: "text", text: prompt }],
                        },
                    },
                    { timeoutMs: timeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS },
                );
                shared.sessionLog(
                    parentSessionId,
                    `historian: prompt completed (attempt ${retryIndex + 1}/${MAX_HISTORIAN_RETRIES + 1})`,
                );
                break;
            } catch (error: unknown) {
                const errorMsg = getErrorMessage(error);
                shared.sessionLog(
                    parentSessionId,
                    `historian: prompt attempt ${retryIndex + 1} failed: ${errorMsg}`,
                );
                const shouldRetry =
                    retryIndex < MAX_HISTORIAN_RETRIES && isTransientHistorianPromptError(errorMsg);
                if (!shouldRetry) {
                    throw error;
                }

                const backoffMs = getHistorianRetryBackoffMs(retryIndex);
                shared.sessionLog(
                    parentSessionId,
                    `historian retry ${retryIndex + 1}/${MAX_HISTORIAN_RETRIES} after ${backoffMs}ms: ${errorMsg}`,
                );
                await sleep(backoffMs);
            }
        }

        const messagesResponse = await client.session.messages({
            path: { id: agentSessionId },
            query: { directory: sessionDirectory },
        });
        const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        const result = extractLatestAssistantText(messages);
        if (!result) {
            return { ok: false, error: "Historian returned no assistant output." };
        }

        const dumpPath = dumpHistorianResponse(
            parentSessionId,
            dumpLabel ?? "historian-response",
            result,
        );
        return { ok: true, result, dumpPath };
    } catch (modelError: unknown) {
        const modelMsg = getErrorMessage(modelError);
        const modelStack = modelError instanceof Error ? modelError.stack : undefined;
        shared.sessionLog(parentSessionId, "compartment agent: historian attempt failed", {
            error: modelMsg,
            promptLength: prompt.length,
            stack: modelStack,
        });
        return { ok: false, error: `Historian failed while processing this session: ${modelMsg}` };
    } finally {
        if (agentSessionId) {
            await client.session
                .delete({ path: { id: agentSessionId }, query: { directory: sessionDirectory } })
                .catch((e: unknown) => {
                    shared.sessionLog(
                        parentSessionId,
                        "compartment agent: session cleanup failed",
                        getErrorMessage(e),
                    );
                });
        }
    }
}

async function runFallbackHistorianPass(args: {
    client: PluginContext["client"];
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
    };
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    dumpLabelBase: string;
    timeoutMs?: number;
    fallbackModelId?: string;
    error: string;
    dumpPaths: Array<string | undefined>;
}): Promise<ValidatedHistorianPassResult> {
    if (!args.fallbackModelId) {
        return { ok: false, error: args.error };
    }

    const modelOverride = parseModelOverride(args.fallbackModelId);
    if (!modelOverride) {
        return { ok: false, error: args.error };
    }

    shared.sessionLog(
        args.parentSessionId,
        `compartment agent: retrying historian with primary session model ${args.fallbackModelId}`,
    );

    const fallbackRun = await runHistorianPrompt({
        client: args.client,
        parentSessionId: args.parentSessionId,
        sessionDirectory: args.sessionDirectory,
        prompt: args.prompt,
        timeoutMs: args.timeoutMs,
        dumpLabel: `${args.dumpLabelBase}-fallback-primary-model`,
        modelOverride,
    });
    if (!fallbackRun.ok || !fallbackRun.result) {
        return { ok: false, error: fallbackRun.error ?? args.error };
    }

    const fallbackValidation = validateHistorianOutput(
        fallbackRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (fallbackValidation.ok) {
        // Only cleanup the successful fallback run's dump.
        // Prior failed dumps (args.dumpPaths) are kept for debugging.
        cleanupHistorianDump(args.parentSessionId, fallbackRun.dumpPath);
    }

    return fallbackValidation;
}

function parseModelOverride(modelId: string): HistorianModelOverride | null {
    const [providerID, ...modelParts] = modelId.split("/");
    const modelID = modelParts.join("/");
    if (!providerID || modelID.length === 0) {
        return null;
    }

    return { providerID, modelID };
}

function getHistorianRetryBackoffMs(retryIndex: number): number {
    if (retryIndex === 0) {
        return 2_000 + Math.floor(Math.random() * 1_001);
    }

    return 6_000 + Math.floor(Math.random() * 2_001);
}

function isTransientHistorianPromptError(message: string): boolean {
    const normalized = message.toLowerCase();
    if (
        normalized.includes("invalid request") ||
        normalized.includes("bad request") ||
        normalized.includes("unauthorized") ||
        normalized.includes("forbidden") ||
        normalized.includes("authentication") ||
        normalized.includes("auth") ||
        normalized.includes(" 400") ||
        normalized.startsWith("400")
    ) {
        return false;
    }

    return [
        "429",
        "rate limit",
        "timeout",
        "econnreset",
        "etimedout",
        "503",
        "502",
        "500",
        "overloaded",
    ].some((token) => normalized.includes(token));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function cleanupHistorianDump(sessionId: string, dumpPath?: string): void {
    if (!dumpPath) return;

    try {
        unlinkSync(dumpPath);
    } catch (error: unknown) {
        shared.sessionLog(
            sessionId,
            "compartment agent: failed to remove historian response dump",
            {
                dumpPath,
                error: getErrorMessage(error),
            },
        );
    }
}

function dumpHistorianResponse(sessionId: string, label: string, text: string): string | undefined {
    try {
        mkdirSync(HISTORIAN_RESPONSE_DUMP_DIR, { recursive: true });
        const safeSessionId = sanitizeDumpName(sessionId);
        const safeLabel = sanitizeDumpName(label);
        const dumpPath = join(
            HISTORIAN_RESPONSE_DUMP_DIR,
            `${safeSessionId}-${safeLabel}-${Date.now()}.xml`,
        );
        writeFileSync(dumpPath, text, "utf8");
        shared.sessionLog(sessionId, "compartment agent: historian response dumped", {
            label,
            dumpPath,
        });
        return dumpPath;
    } catch (error: unknown) {
        shared.sessionLog(sessionId, "compartment agent: failed to dump historian response", {
            label,
            error: getErrorMessage(error),
        });
        return undefined;
    }
}

function sanitizeDumpName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
