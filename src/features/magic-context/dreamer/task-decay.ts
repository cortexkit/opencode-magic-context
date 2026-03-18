import type { Database } from "bun:sqlite";
import { archiveMemory, updateMemoryStatus } from "../memory/storage-memory";

const UNUSED_MEMORY_AGE_MS = 180 * 24 * 60 * 60 * 1000;

interface IdRow {
    id: number;
}

export interface DecayResult {
    expired: number;
    promoted: number;
    archived: number;
}

function isIdRow(row: unknown): row is IdRow {
    return row !== null && typeof row === "object" && typeof (row as IdRow).id === "number";
}

export async function runDecayTask(
    db: Database,
    config: { promotionThreshold: number },
): Promise<DecayResult> {
    const now = Date.now();
    const cutoff = now - UNUSED_MEMORY_AGE_MS;

    const expiredIds = db
        .prepare(
            "SELECT id FROM memories WHERE status != 'archived' AND expires_at IS NOT NULL AND expires_at < ? ORDER BY id ASC",
        )
        .all(now)
        .filter(isIdRow)
        .map((row) => row.id);

    for (const id of expiredIds) {
        archiveMemory(db, id);
    }

    const promotedIds = db
        .prepare(
            "SELECT id FROM memories WHERE status = 'active' AND retrieval_count >= ? ORDER BY id ASC",
        )
        .all(config.promotionThreshold)
        .filter(isIdRow)
        .map((row) => row.id);

    for (const id of promotedIds) {
        updateMemoryStatus(db, id, "permanent");
    }

    const archivalIds = db
        .prepare(
            `SELECT id FROM memories
             WHERE status = 'active'
               AND (
                   (last_retrieved_at IS NULL AND created_at < ?)
                   OR (last_retrieved_at IS NOT NULL AND last_retrieved_at < ?)
               )
             ORDER BY id ASC`,
        )
        .all(cutoff, cutoff)
        .filter(isIdRow)
        .map((row) => row.id)
        .filter((id) => !expiredIds.includes(id));

    for (const id of archivalIds) {
        archiveMemory(db, id);
    }

    return {
        expired: expiredIds.length,
        promoted: promotedIds.length,
        archived: archivalIds.length,
    };
}
