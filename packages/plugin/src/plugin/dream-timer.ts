import type { DreamerConfig, EmbeddingConfig } from "../config/schema/magic-context";
import { checkScheduleAndEnqueue, processDreamQueue } from "../features/magic-context/dreamer";
import {
    embedUnembeddedCommits,
    indexCommitsForProject,
} from "../features/magic-context/git-commits";
import { embedAllUnembeddedMemories } from "../features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { openDatabase } from "../features/magic-context/storage";
import { log } from "../shared/logger";
import type { PluginContext } from "./types";

/** Check interval for dream schedule (15 minutes). */
const DREAM_TIMER_INTERVAL_MS = 15 * 60 * 1000;

/** Singleton guard — only one timer per process. */
let activeTimer: ReturnType<typeof setInterval> | null = null;
let activeCleanup: (() => void) | null = null;

/**
 * Start an independent timer that checks the dreamer schedule and processes
 * the dream queue. This runs regardless of user activity so overnight
 * dreaming triggers even when the user isn't chatting.
 *
 * The timer is unref'd so it doesn't prevent the process from exiting.
 */
export function startDreamScheduleTimer(args: {
    directory: string;
    client: PluginContext["client"];
    dreamerConfig?: DreamerConfig;
    embeddingConfig: EmbeddingConfig;
    memoryEnabled: boolean;
    experimentalUserMemories?: { enabled: boolean; promotionThreshold: number };
    experimentalPinKeyFiles?: {
        enabled: boolean;
        token_budget: number;
        min_reads: number;
    };
    /** When set, periodically index git commits from `directory` into the
     *  current project's commit table. Embeddings are drained as part of the
     *  same tick when embedding is enabled. */
    gitCommitIndexing?: {
        enabled: boolean;
        since_days: number;
        max_commits: number;
    };
}): (() => void) | undefined {
    // Singleton guard — only one timer per process
    if (activeTimer) {
        log("[dreamer] schedule timer already running, skipping duplicate start");
        return activeCleanup ?? undefined;
    }

    const {
        directory,
        client,
        dreamerConfig,
        embeddingConfig,
        memoryEnabled,
        experimentalUserMemories,
        experimentalPinKeyFiles,
        gitCommitIndexing,
    } = args;
    const dreamingEnabled = Boolean(dreamerConfig?.enabled && dreamerConfig.schedule?.trim());
    const embeddingSweepEnabled = memoryEnabled && embeddingConfig.provider !== "off";
    const commitIndexingEnabled = gitCommitIndexing?.enabled === true;

    if (!dreamingEnabled && !embeddingSweepEnabled && !commitIndexingEnabled) {
        return;
    }

    // Kick off a startup sweep for git commits so first-time indexing doesn't
    // wait 15 minutes. Fire-and-forget — any failure is logged and recovered
    // on the next interval.
    if (commitIndexingEnabled && gitCommitIndexing) {
        void sweepGitCommits({ directory, gitCommitIndexing, embeddingConfig });
    }

    const timer = setInterval(() => {
        log("[dreamer] timer tick — checking schedule and embeddings");
        try {
            if (embeddingSweepEnabled) {
                void embedAllUnembeddedMemories(openDatabase(), embeddingConfig)
                    .then((embeddedCount) => {
                        if (embeddedCount > 0) {
                            log(
                                `[magic-context] proactively embedded ${embeddedCount} ${embeddedCount === 1 ? "memory" : "memories"} across all projects`,
                            );
                        }
                    })
                    .catch((error: unknown) => {
                        log("[magic-context] periodic memory embedding sweep failed:", error);
                    });
            }

            if (commitIndexingEnabled && gitCommitIndexing) {
                void sweepGitCommits({ directory, gitCommitIndexing, embeddingConfig });
            }

            if (!dreamingEnabled || !dreamerConfig?.schedule?.trim()) {
                log("[dreamer] timer tick — dreaming disabled, skipping schedule check");
                return;
            }

            const db = openDatabase();
            log(`[dreamer] timer tick — checking schedule window "${dreamerConfig.schedule}"`);
            checkScheduleAndEnqueue(db, dreamerConfig.schedule);

            void processDreamQueue({
                db,
                client,
                tasks: dreamerConfig.tasks,
                taskTimeoutMinutes: dreamerConfig.task_timeout_minutes,
                maxRuntimeMinutes: dreamerConfig.max_runtime_minutes,
                experimentalUserMemories,
                experimentalPinKeyFiles,
            }).catch((error: unknown) => {
                log("[dreamer] timer-triggered queue processing failed:", error);
            });
        } catch (error) {
            log("[magic-context] timer-triggered maintenance check failed:", error);
        }
    }, DREAM_TIMER_INTERVAL_MS);

    // Unref so the timer doesn't prevent the process from exiting.
    if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
    }

    const cleanup = () => {
        clearInterval(timer);
        activeTimer = null;
        activeCleanup = null;
        log("[dreamer] stopped dream schedule timer");
    };

    activeTimer = timer;
    activeCleanup = cleanup;

    log(
        `[dreamer] started independent schedule timer (every ${DREAM_TIMER_INTERVAL_MS / 60_000}m)`,
    );

    return cleanup;
}

/**
 * Index commits for the current project and drain embeddings. Runs in the
 * background under the timer's fire-and-forget contract.
 *
 * Project identity resolution happens inside the indexer so we always read
 * the same `git:<sha>` identity used by memories and ctx_search.
 */
async function sweepGitCommits(args: {
    directory: string;
    gitCommitIndexing: { enabled: boolean; since_days: number; max_commits: number };
    embeddingConfig: EmbeddingConfig;
}): Promise<void> {
    const { directory, gitCommitIndexing, embeddingConfig } = args;
    try {
        const db = openDatabase();
        const projectPath = resolveProjectIdentity(directory);
        const result = await indexCommitsForProject(db, projectPath, directory, embeddingConfig, {
            sinceDays: gitCommitIndexing.since_days,
            maxCommits: gitCommitIndexing.max_commits,
        });
        // Drain any remaining embedding backlog (indexer caps per run).
        if (embeddingConfig.provider !== "off" && result.embedded > 0) {
            await embedUnembeddedCommits(db, projectPath, embeddingConfig);
        }
    } catch (error) {
        log(
            `[git-commits] sweep failed for ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
