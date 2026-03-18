/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let index = 0; index < a.length; index++) {
        dotProduct += a[index]! * b[index]!;
        normA += a[index]! * a[index]!;
        normB += b[index]! * b[index]!;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

const embeddedContent = new Map<string, Float32Array | null>();
const mockEmbedText = mock(async (text: string) => {
    const embedding = embeddedContent.get(text);
    return embedding ? new Float32Array(embedding) : null;
});

mock.module("../memory/embedding", () => ({
    embedText: mockEmbedText,
    getEmbeddingModelId: () => "mock:model",
    cosineSimilarity,
}));

const { initializeDatabase } = await import("../storage-db");
const { getMemoriesByProject, getMemoryById, insertMemory } = await import(
    "../memory/storage-memory"
);
const { loadAllEmbeddings, saveEmbedding } = await import("../memory/storage-memory-embeddings");
const { acquireLease, getLeaseHolder, isLeaseActive, releaseLease, renewLease } = await import(
    "./lease"
);
const { runDream } = await import("./runner");
const { getDreamState } = await import("./storage-dream-state");
const { runConsolidateTask } = await import("./task-consolidate");
const { runDecayTask } = await import("./task-decay");

const DAY_MS = 24 * 60 * 60 * 1000;

let db: Database | null = null;

function createTestDb(): Database {
    const database = Database.open(":memory:");
    initializeDatabase(database);
    return database;
}

function saveUnitEmbedding(memoryId: number, values: number[]): void {
    if (!db) {
        throw new Error("db not initialized");
    }

    saveEmbedding(db, memoryId, new Float32Array(values), "mock:model");
}

beforeEach(() => {
    embeddedContent.clear();
    mockEmbedText.mockReset();
    mockEmbedText.mockImplementation(async (text: string) => {
        const embedding = embeddedContent.get(text);
        return embedding ? new Float32Array(embedding) : null;
    });
});

afterEach(() => {
    if (db) {
        try {
            db.close(false);
        } catch {
        } finally {
            db = null;
        }
    }
});

afterAll(() => {
    mock.restore();
});

describe("dreamer", () => {
    describe("decay", () => {
        it("archives memories past TTL expiry", async () => {
            db = createTestDb();
            const nowSpy = spyOn(Date, "now").mockReturnValue(10_000);
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Expired memory",
                expiresAt: 5_000,
            });

            const result = await runDecayTask(db, { promotionThreshold: 3 });

            expect(result).toEqual({ expired: 1, promoted: 0, archived: 0 });
            expect(getMemoryById(db, memory.id)?.status).toBe("archived");
            nowSpy.mockRestore();
        });

        it("promotes active memories by retrieval_count threshold", async () => {
            db = createTestDb();
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Promote this memory",
            });
            db.prepare("UPDATE memories SET retrieval_count = 3 WHERE id = ?").run(memory.id);

            const result = await runDecayTask(db, { promotionThreshold: 3 });

            expect(result).toEqual({ expired: 0, promoted: 1, archived: 0 });
            expect(getMemoryById(db, memory.id)?.status).toBe("permanent");
        });

        it("archives unused active memories after 180 days", async () => {
            db = createTestDb();
            const now = 200 * DAY_MS;
            const nowSpy = spyOn(Date, "now").mockReturnValue(now);
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ENVIRONMENT",
                content: "Unused memory",
            });
            db.prepare(
                "UPDATE memories SET created_at = ?, first_seen_at = ?, last_seen_at = ?, updated_at = ? WHERE id = ?",
            ).run(
                now - 181 * DAY_MS,
                now - 181 * DAY_MS,
                now - 181 * DAY_MS,
                now - 181 * DAY_MS,
                memory.id,
            );

            const result = await runDecayTask(db, { promotionThreshold: 5 });

            expect(result).toEqual({ expired: 0, promoted: 0, archived: 1 });
            expect(getMemoryById(db, memory.id)?.status).toBe("archived");
            nowSpy.mockRestore();
        });
    });

    describe("consolidation", () => {
        it("merges near-duplicate memories within the same category", async () => {
            db = createTestDb();
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Use createMemoryStore naming",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Use createMemoryStore naming consistently",
            });
            saveUnitEmbedding(first.id, [1, 0]);
            saveUnitEmbedding(second.id, [0.99, 0.14106736]);
            embeddedContent.set(second.content, new Float32Array([0.99, 0.14106736]));

            const result = await runConsolidateTask(db, "/repo/project");

            expect(result.clustersFound).toBe(1);
            expect(result.memoriesSuperseded).toBe(1);
            expect(getMemoryById(db, first.id)?.status).toBe("archived");
            expect(getMemoryById(db, first.id)?.supersededByMemoryId).toBe(second.id);
            expect(getMemoriesByProject(db, "/repo/project").map((memory) => memory.id)).toEqual([
                second.id,
            ]);
        });

        it("respects category-specific similarity thresholds", async () => {
            db = createTestDb();
            const namingA = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Use createWidget naming",
            });
            const namingB = insertMemory(db, {
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Prefer createWidget factory naming",
            });
            const constraintsA = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Never use npm in this repo",
            });
            const constraintsB = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Do not use npm in this repository",
            });
            const borderline = [0.94, 0.34117445];
            saveUnitEmbedding(namingA.id, [1, 0]);
            saveUnitEmbedding(namingB.id, borderline);
            saveUnitEmbedding(constraintsA.id, [1, 0]);
            saveUnitEmbedding(constraintsB.id, borderline);
            embeddedContent.set(constraintsB.content, new Float32Array(borderline));

            const result = await runConsolidateTask(db, "/repo/project");

            expect(result.clustersFound).toBe(1);
            expect(getMemoryById(db, namingA.id)?.status).toBe("active");
            expect(getMemoryById(db, namingB.id)?.status).toBe("active");
            expect(getMemoryById(db, constraintsA.id)?.status).toBe("archived");
            expect(getMemoryById(db, constraintsB.id)?.status).toBe("active");
        });

        it("keeps the longer content as survivor", async () => {
            db = createTestDb();
            const shorter = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Run tests",
            });
            const longer = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Run tests and typecheck before finishing any task",
            });
            saveUnitEmbedding(shorter.id, [1, 0]);
            saveUnitEmbedding(longer.id, [0.98, 0.19899748]);

            const result = await runConsolidateTask(db, "/repo/project");

            expect(result.clustersFound).toBe(1);
            expect(getMemoryById(db, shorter.id)?.status).toBe("archived");
            expect(getMemoryById(db, shorter.id)?.supersededByMemoryId).toBe(longer.id);
            expect(getMemoryById(db, longer.id)?.content).toBe(longer.content);
        });

        it("merges stats and provenance correctly", async () => {
            db = createTestDb();
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Use SQLite for cross-session memory",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "ARCHITECTURE_DECISIONS",
                content: "Use SQLite for persistent cross-session memory",
            });
            db.prepare(
                "UPDATE memories SET seen_count = ?, retrieval_count = ?, merged_from = ?, status = ? WHERE id = ?",
            ).run(2, 4, JSON.stringify([99]), "permanent", second.id);
            saveUnitEmbedding(first.id, [1, 0]);
            saveUnitEmbedding(second.id, [0.97, 0.24310492]);

            await runConsolidateTask(db, "/repo/project");

            const survivor = getMemoryById(db, second.id);
            expect(survivor?.seenCount).toBe(3);
            expect(survivor?.retrievalCount).toBe(4);
            expect(survivor?.status).toBe("permanent");
            expect(survivor?.mergedFrom).toBe(JSON.stringify([first.id, second.id, 99]));
        });

        it("does not merge across categories", async () => {
            db = createTestDb();
            const directive = insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always run bun test",
            });
            const workflow = insertMemory(db, {
                projectPath: "/repo/project",
                category: "WORKFLOW_RULES",
                content: "Always run bun test before release",
            });
            saveUnitEmbedding(directive.id, [1, 0]);
            saveUnitEmbedding(workflow.id, [1, 0]);

            const result = await runConsolidateTask(db, "/repo/project");

            expect(result).toEqual({ clustersFound: 0, memoriesMerged: 0, memoriesSuperseded: 0 });
            expect(getMemoryById(db, directive.id)?.status).toBe("active");
            expect(getMemoryById(db, workflow.id)?.status).toBe("active");
        });
    });

    describe("lease", () => {
        it("supports acquire, renew, and release cycle", () => {
            db = createTestDb();
            const nowSpy = spyOn(Date, "now");
            nowSpy.mockReturnValue(1_000);

            expect(acquireLease(db, "holder-a")).toBe(true);
            expect(isLeaseActive(db)).toBe(true);
            expect(getLeaseHolder(db)).toBe("holder-a");

            nowSpy.mockReturnValue(2_000);
            expect(renewLease(db, "holder-a")).toBe(true);
            expect(getDreamState(db, "dreaming_lease_heartbeat")).toBe("2000");
            expect(getDreamState(db, "dreaming_lease_expiry")).toBe(String(122_000));

            releaseLease(db, "holder-a");
            expect(isLeaseActive(db)).toBe(false);
            expect(getLeaseHolder(db)).toBeNull();
            nowSpy.mockRestore();
        });

        it("allows stale leases to be overridden", () => {
            db = createTestDb();
            const nowSpy = spyOn(Date, "now");
            nowSpy.mockReturnValue(1_000);
            expect(acquireLease(db, "holder-a")).toBe(true);

            nowSpy.mockReturnValue(122_001);
            expect(acquireLease(db, "holder-b")).toBe(true);
            expect(getLeaseHolder(db)).toBe("holder-b");
            nowSpy.mockRestore();
        });
    });

    describe("dream runner", () => {
        it("orchestrates tasks in order", async () => {
            db = createTestDb();
            const expiring = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Expires during dream",
                expiresAt: 1,
            });
            const duplicateA = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const duplicateB = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for all scripts in this repo",
            });
            saveUnitEmbedding(duplicateA.id, [1, 0]);
            saveUnitEmbedding(duplicateB.id, [0.96, 0.28]);
            embeddedContent.set(duplicateB.content, new Float32Array([0.96, 0.28]));

            const result = await runDream({
                db,
                projectPath: "/repo/project",
                tasks: ["decay", "consolidate"],
                promotionThreshold: 3,
                maxRuntimeMinutes: 10,
            });

            expect(result.tasks.map((task) => task.name)).toEqual(["decay", "consolidate"]);
            expect(result.tasks.every((task) => task.durationMs >= 0)).toBe(true);
            expect(getMemoryById(db, expiring.id)?.status).toBe("archived");
            expect(getMemoryById(db, duplicateA.id)?.status).toBe("archived");
            expect(getMemoryById(db, duplicateA.id)?.supersededByMemoryId).toBe(duplicateB.id);
            expect(getDreamState(db, "last_dream_at")).not.toBeNull();
            expect(isLeaseActive(db)).toBe(false);
            expect(loadAllEmbeddings(db, "/repo/project").has(duplicateB.id)).toBe(true);
        });
    });
});
