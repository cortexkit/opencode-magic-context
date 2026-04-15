/**
 * Compaction Marker Manager
 *
 * Coordinates compaction marker injection/update/removal with historian
 * publication. Called after compartments are published, behind the
 * `compaction_markers` config flag (default: true).
 *
 * The marker summary text is a static placeholder — the real <session-history>
 * is injected by the transform pipeline via inject-compartments.ts. The marker
 * exists solely to make OpenCode's filterCompacted stop at the boundary so the
 * transform receives only the live tail.
 */

import type { Database } from "bun:sqlite";
import {
    closeCompactionMarkerDb,
    injectCompactionMarker,
    removeCompactionMarker,
} from "../../features/magic-context/compaction-marker";
import {
    getPersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { sessionLog } from "../../shared/logger";

/** Static placeholder — the real session-history comes from transform injection. */
const MARKER_SUMMARY_TEXT =
    "[Compacted by magic-context — session history is managed by the plugin]";

/**
 * After historian publishes new compartments, inject or move the compaction marker.
 * Only moves the boundary forward; summary text is a static placeholder.
 */
export function updateCompactionMarkerAfterPublication(
    db: Database,
    sessionId: string,
    lastCompartmentEnd: number,
    directory?: string,
): void {
    const existing = getPersistedCompactionMarkerState(db, sessionId);

    if (existing) {
        if (existing.boundaryOrdinal === lastCompartmentEnd) {
            // Same boundary — nothing to do (placeholder text never changes)
            return;
        }

        // Boundary moved forward — remove old marker and inject new one.
        // Clear persisted state only after successful removal to avoid orphaned DB rows.
        try {
            removeCompactionMarker(existing);
            setPersistedCompactionMarkerState(db, sessionId, null);
            sessionLog(
                sessionId,
                `compaction-marker: removed old boundary at ordinal ${existing.boundaryOrdinal}, moving to ${lastCompartmentEnd}`,
            );
        } catch (error) {
            sessionLog(
                sessionId,
                `compaction-marker: failed to remove old boundary at ordinal ${existing.boundaryOrdinal}, proceeding with new injection:`,
                error,
            );
            // State kept so next cleanup/update can retry removal
        }
    }

    const result = injectCompactionMarker({
        sessionId,
        endOrdinal: lastCompartmentEnd,
        summaryText: MARKER_SUMMARY_TEXT,
        directory: directory ?? process.cwd(),
    });

    if (result) {
        setPersistedCompactionMarkerState(db, sessionId, {
            ...result,
            boundaryOrdinal: lastCompartmentEnd,
        });
        sessionLog(
            sessionId,
            `compaction-marker: injected at ordinal ${lastCompartmentEnd}, boundary user msg ${result.boundaryMessageId}`,
        );
    }
}

/**
 * Remove the compaction marker for a session (e.g. on session.deleted).
 */
export function removeCompactionMarkerForSession(db: Database, sessionId: string): void {
    const existing = getPersistedCompactionMarkerState(db, sessionId);
    if (existing) {
        try {
            removeCompactionMarker(existing);
            setPersistedCompactionMarkerState(db, sessionId, null);
            sessionLog(sessionId, "compaction-marker: removed on session cleanup");
        } catch (error) {
            // Clear state anyway on session deletion — orphaned rows in OpenCode's DB
            // are acceptable since the session is being deleted, and retaining stale
            // persisted state for a deleted session causes worse problems.
            setPersistedCompactionMarkerState(db, sessionId, null);
            sessionLog(
                sessionId,
                "compaction-marker: removal failed during session cleanup, cleared persisted state:",
                error,
            );
        }
    }
}

/**
 * Close the writable OpenCode DB connection used for marker injection.
 */
export function closeCompactionMarkerConnection(): void {
    closeCompactionMarkerDb();
}
