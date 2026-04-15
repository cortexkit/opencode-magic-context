/**
 * Compaction Marker Injection
 *
 * Injects compaction boundaries into OpenCode's SQLite DB so that
 * `filterCompacted` stops at the historian boundary. After injection,
 * the transform hook receives only post-boundary messages instead
 * of the full session history.
 *
 * Gated behind the `compaction_markers` config flag (default: true).
 *
 * ## What gets injected (3 rows):
 * 1. A `compaction` part on the boundary user message
 * 2. A summary assistant message with `parentID` → boundary user message
 * 3. A text part on that summary message containing a static placeholder
 *
 * The real `<session-history>` is injected by the transform pipeline via
 * inject-compartments.ts. The marker exists solely to make filterCompacted
 * stop at the boundary.
 *
 * ## How OpenCode's filterCompacted works:
 * - Iterates newest→oldest
 * - Stops when it finds a user message that:
 *   (a) has a part with type: "compaction"
 *   (b) has a completed summary assistant response (summary: true, finish: "stop")
 *       whose parentID matches that user message's id
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getDataDir } from "../../shared/data-path";
import { log } from "../../shared/logger";

// ── ID Generation ────────────────────────────────────────────────

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length: number): string {
    const chars: string[] = [];
    for (let i = 0; i < length; i++) {
        chars.push(BASE62_CHARS[Math.floor(Math.random() * BASE62_CHARS.length)]);
    }
    return chars.join("");
}

/**
 * Generate an OpenCode-compatible ascending ID.
 * Format: `prefix_[hex-chars][14-random-base62]`
 * The hex encodes `BigInt(timestamp_ms) * 0x1000n + counter`.
 * Current timestamps produce 14 hex chars; padStart(14) ensures consistency.
 */
function generateId(prefix: string, timestampMs: number, counter = 0n): string {
    const encoded = BigInt(timestampMs) * 0x1000n + counter;
    const hex = encoded.toString(16).padStart(14, "0");
    return `${prefix}_${hex}${randomBase62(14)}`;
}

export function generateMessageId(timestampMs: number, counter = 0n): string {
    return generateId("msg", timestampMs, counter);
}

export function generatePartId(timestampMs: number, counter = 0n): string {
    return generateId("prt", timestampMs, counter);
}

// ── DB Access ────────────────────────────────────────────────────

function getOpenCodeDbPath(): string {
    return join(getDataDir(), "opencode", "opencode.db");
}

let cachedWriteDb: { path: string; db: Database } | null = null;

function getWritableOpenCodeDb(): Database {
    const dbPath = getOpenCodeDbPath();
    if (cachedWriteDb?.path === dbPath) {
        return cachedWriteDb.db;
    }
    if (cachedWriteDb) {
        try {
            cachedWriteDb.db.close(false);
        } catch {
            // ignore
        }
    }
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    // Allow up to 5s wait when OpenCode holds a write lock
    db.exec("PRAGMA busy_timeout=5000");
    cachedWriteDb = { path: dbPath, db };
    return db;
}

export function closeCompactionMarkerDb(): void {
    if (cachedWriteDb) {
        try {
            cachedWriteDb.db.close(false);
        } catch {
            // ignore
        }
        cachedWriteDb = null;
    }
}

// ── Boundary User Message Resolution ─────────────────────────────

interface BoundaryUserMessage {
    id: string;
    timeCreated: number;
}

/**
 * Find the nearest user message at or before the given raw ordinal.
 * The boundary must be a user message for filterCompacted to work.
 *
 * Filters out compaction summary messages (summary=true, finish="stop")
 * so ordinals stay consistent with readRawSessionMessagesFromDb.
 */
export function findBoundaryUserMessage(
    sessionId: string,
    endOrdinal: number,
): BoundaryUserMessage | null {
    const db = getWritableOpenCodeDb();

    const rows = db
        .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId) as Array<{ id: string; time_created: number; data: string }>;

    // Filter out our own injected summary messages to keep ordinal parity
    const filtered = rows.filter((row) => {
        try {
            const info = JSON.parse(row.data);
            return !(info.summary === true && info.finish === "stop");
        } catch {
            return true;
        }
    });

    let bestMatch: BoundaryUserMessage | null = null;

    for (let i = 0; i < filtered.length && i < endOrdinal; i++) {
        const row = filtered[i];
        try {
            const info = JSON.parse(row.data);
            if (info.role === "user") {
                bestMatch = { id: row.id, timeCreated: row.time_created };
            }
        } catch {
            // skip corrupt rows
        }
    }

    return bestMatch;
}

// ── Marker State ─────────────────────────────────────────────────

interface CompactionMarkerState {
    /** The user message ID that has the compaction part */
    boundaryMessageId: string;
    /** The summary assistant message ID we injected */
    summaryMessageId: string;
    /** The compaction part ID on the user message */
    compactionPartId: string;
    /** The text part ID on the summary message */
    summaryPartId: string;
}

// ── Injection ────────────────────────────────────────────────────

export interface InjectCompactionMarkerArgs {
    sessionId: string;
    /** Raw ordinal of the last compartmentalized message */
    endOrdinal: number;
    /** Summary text for the compaction summary message (static placeholder) */
    summaryText: string;
    /** Working directory for the session */
    directory: string;
}

/**
 * Inject a compaction marker into OpenCode's DB.
 * Returns the marker state if successful, null if boundary couldn't be found.
 */
export function injectCompactionMarker(
    args: InjectCompactionMarkerArgs,
): CompactionMarkerState | null {
    const boundary = findBoundaryUserMessage(args.sessionId, args.endOrdinal);
    if (!boundary) {
        log(
            `[magic-context] compaction-marker: no user message found at or before ordinal ${args.endOrdinal}`,
        );
        return null;
    }

    const db = getWritableOpenCodeDb();
    // Use timestamps relative to the boundary so sort order is consistent
    const boundaryTime = boundary.timeCreated;

    // Generate IDs with timestamps that sort correctly — right after the boundary
    const summaryMsgId = generateMessageId(boundaryTime + 1, 1n);
    const compactionPartId = generatePartId(boundaryTime, 1n);
    const summaryPartId = generatePartId(boundaryTime + 1, 2n);

    const summaryMsgData = JSON.stringify({
        role: "assistant",
        parentID: boundary.id,
        summary: true,
        finish: "stop",
        mode: "compaction",
        agent: "compaction",
        path: { cwd: args.directory, root: args.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "magic-context",
        providerID: "magic-context",
        time: { created: boundaryTime + 1 },
    });

    try {
        db.transaction(() => {
            // 1. Add compaction part to the boundary user message
            db.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
                compactionPartId,
                boundary.id,
                args.sessionId,
                boundaryTime,
                boundaryTime,
                '{"type":"compaction","auto":true}',
            );

            // 2. Insert summary assistant message
            db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(summaryMsgId, args.sessionId, boundaryTime + 1, boundaryTime + 1, summaryMsgData);

            // 3. Insert text part with the summary content
            db.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
                summaryPartId,
                summaryMsgId,
                args.sessionId,
                boundaryTime + 1,
                boundaryTime + 1,
                JSON.stringify({ type: "text", text: args.summaryText }),
            );
        })();

        log(
            `[magic-context] compaction-marker: injected boundary at user msg ${boundary.id} (ordinal ~${args.endOrdinal}), summary msg ${summaryMsgId}`,
        );

        return {
            boundaryMessageId: boundary.id,
            summaryMessageId: summaryMsgId,
            compactionPartId,
            summaryPartId,
        };
    } catch (error) {
        log(
            `[magic-context] compaction-marker: injection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
    }
}

// ── Removal ──────────────────────────────────────────────────────

/**
 * Remove an existing compaction marker (all 3 rows).
 * Used when moving the boundary forward or on session cleanup.
 */
export function removeCompactionMarker(state: CompactionMarkerState): boolean {
    try {
        const db = getWritableOpenCodeDb();
        db.transaction(() => {
            // Delete in reverse order of dependencies
            db.prepare("DELETE FROM part WHERE id = ?").run(state.summaryPartId);
            db.prepare("DELETE FROM message WHERE id = ?").run(state.summaryMessageId);
            db.prepare("DELETE FROM part WHERE id = ?").run(state.compactionPartId);
        })();
        return true;
    } catch (error) {
        log(
            `[magic-context] compaction-marker: removal failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
}
