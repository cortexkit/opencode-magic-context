import type { Database } from "bun:sqlite";
import { cosineSimilarity, embedText, getEmbeddingModelId } from "../memory/embedding";
import { computeNormalizedHash } from "../memory/normalize-hash";
import { loadAllEmbeddings, saveEmbedding } from "../memory/storage-memory-embeddings";
import {
    getMemoriesByProject,
    mergeMemoryStats,
    supersededMemory,
    updateMemoryContent,
} from "../memory/storage-memory";
import type { Memory, MemoryCategory, MemoryStatus } from "../memory/types";

const CATEGORY_THRESHOLDS: Record<MemoryCategory, number> = {
    CONFIG_DEFAULTS: 0.95,
    NAMING: 0.95,
    USER_DIRECTIVES: 0.95,
    USER_PREFERENCES: 0.95,
    CONSTRAINTS: 0.9,
    ARCHITECTURE_DECISIONS: 0.9,
    ENVIRONMENT: 0.9,
    KNOWN_ISSUES: 0.85,
    WORKFLOW_RULES: 0.85,
};

export interface ConsolidationResult {
    clustersFound: number;
    memoriesMerged: number;
    memoriesSuperseded: number;
}

function parseMergedFrom(memory: Memory): number[] {
    const parsed = memory.mergedFrom ? JSON.parse(memory.mergedFrom) : [];
    return Array.isArray(parsed)
        ? parsed.filter((value): value is number => typeof value === "number")
        : [];
}

function getBestStatus(memories: Memory[]): MemoryStatus {
    return memories.some((memory) => memory.status === "permanent") ? "permanent" : "active";
}

function chooseSurvivor(memories: Memory[]): Memory {
    return [...memories].sort((left, right) => {
        const contentLengthDelta = right.content.length - left.content.length;
        if (contentLengthDelta !== 0) {
            return contentLengthDelta;
        }

        const retrievalDelta = right.retrievalCount - left.retrievalCount;
        if (retrievalDelta !== 0) {
            return retrievalDelta;
        }

        return left.id - right.id;
    })[0]!;
}

export async function runConsolidateTask(
    db: Database,
    projectPath: string,
): Promise<ConsolidationResult> {
    const memories = getMemoriesByProject(db, projectPath, ["active", "permanent"]).sort(
        (left, right) => left.id - right.id,
    );
    const embeddings = loadAllEmbeddings(db, projectPath);
    const mergedIds = new Set<number>();
    const result: ConsolidationResult = {
        clustersFound: 0,
        memoriesMerged: 0,
        memoriesSuperseded: 0,
    };

    for (const seed of memories) {
        if (mergedIds.has(seed.id)) {
            continue;
        }

        const threshold = CATEGORY_THRESHOLDS[seed.category];
        const seedEmbedding = embeddings.get(seed.id);
        if (!seedEmbedding) {
            continue;
        }

        const cluster: Memory[] = [seed];
        for (const candidate of memories) {
            if (
                candidate.id <= seed.id ||
                mergedIds.has(candidate.id) ||
                candidate.category !== seed.category
            ) {
                continue;
            }

            const candidateEmbedding = embeddings.get(candidate.id);
            if (!candidateEmbedding) {
                continue;
            }

            if (cosineSimilarity(seedEmbedding, candidateEmbedding) >= threshold) {
                cluster.push(candidate);
            }
        }

        if (cluster.length < 2) {
            continue;
        }

        const survivor = chooseSurvivor(cluster);
        const losers = cluster.filter((memory) => memory.id !== survivor.id);
        const mergedFrom = JSON.stringify(
            Array.from(
                new Set(
                    cluster.flatMap((memory) => [memory.id, ...parseMergedFrom(memory)]),
                ).values(),
            ).sort((left, right) => left - right),
        );
        const nextSeenCount = cluster.reduce((sum, memory) => sum + memory.seenCount, 0);
        const nextRetrievalCount = cluster.reduce((sum, memory) => sum + memory.retrievalCount, 0);
        const nextStatus = getBestStatus(cluster);
        const longestContentMemory = [...cluster].sort(
            (left, right) => right.content.length - left.content.length,
        )[0]!;
        const contentChanged = longestContentMemory.content.length > survivor.content.length;
        const nextContent = contentChanged ? longestContentMemory.content : survivor.content;
        const nextEmbedding = contentChanged ? await embedText(nextContent) : null;

        db.transaction(() => {
            mergeMemoryStats(
                db,
                survivor.id,
                nextSeenCount,
                nextRetrievalCount,
                mergedFrom,
                nextStatus,
            );

            if (contentChanged) {
                updateMemoryContent(
                    db,
                    survivor.id,
                    nextContent,
                    computeNormalizedHash(nextContent),
                );
                if (nextEmbedding) {
                    saveEmbedding(db, survivor.id, nextEmbedding, getEmbeddingModelId());
                }
            }

            for (const loser of losers) {
                supersededMemory(db, loser.id, survivor.id);
            }
        })();

        for (const memory of cluster) {
            mergedIds.add(memory.id);
        }

        result.clustersFound += 1;
        result.memoriesMerged += cluster.length;
        result.memoriesSuperseded += losers.length;
    }

    return result;
}
