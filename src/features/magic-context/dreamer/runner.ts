import type { Database } from "bun:sqlite";
import { acquireLease, getLeaseHolder, releaseLease, renewLease } from "./lease";
import { setDreamState } from "./storage-dream-state";
import { runConsolidateTask } from "./task-consolidate";
import { runDecayTask } from "./task-decay";

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
    projectPath: string;
    tasks: string[];
    promotionThreshold: number;
    maxRuntimeMinutes: number;
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

    try {
        for (const taskName of args.tasks) {
            if (Date.now() > deadline) {
                break;
            }

            const taskStartedAt = Date.now();

            try {
                let taskResult: unknown;
                if (taskName === "decay") {
                    taskResult = await runDecayTask(args.db, {
                        promotionThreshold: args.promotionThreshold,
                    });
                } else if (taskName === "consolidate") {
                    taskResult = await runConsolidateTask(args.db, args.projectPath);
                } else {
                    throw new Error(`Dream task \"${taskName}\" is not implemented yet`);
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
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            renewLease(args.db, holderId);
        }
    } finally {
        releaseLease(args.db, holderId);
    }

    result.finishedAt = Date.now();
    setDreamState(args.db, "last_dream_at", String(result.finishedAt));
    return result;
}
