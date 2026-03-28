/**
 * Note nudge state machine.
 *
 * State: idle → (trigger fires + notes exist) → nudged → (any trigger fires again) → nudged → ...
 * Suppression: after a nudge fires, suppress until the NEXT trigger event (any of 3).
 *
 * Triggers:
 *   1. Post-historian completion — compartments just compressed history
 *   2. Post-commit detection — agent committed work, natural boundary
 *   3. Todos complete — agent finished planned work, receptive to deferred items
 *
 * The nudge itself is a short reminder folded into the existing nudge anchor.
 * It does NOT include note content — just a count and "use ctx_note read" hint.
 */

import type { Database } from "bun:sqlite";
import { getSessionNotes } from "../../features/magic-context/storage-notes";
import { sessionLog } from "../../shared/logger";

export type NoteNudgeTrigger = "historian_complete" | "commit_detected" | "todos_complete";

interface NoteNudgeState {
    /** Whether a nudge has been delivered and not yet followed by a new trigger */
    nudgeDelivered: boolean;
    /** Whether a new trigger has fired since last delivery — ready to nudge again */
    triggerPending: boolean;
}

const stateBySession = new Map<string, NoteNudgeState>();

function getState(sessionId: string): NoteNudgeState {
    let state = stateBySession.get(sessionId);
    if (!state) {
        state = { nudgeDelivered: false, triggerPending: false };
        stateBySession.set(sessionId, state);
    }
    return state;
}

/**
 * Signal that a trigger event occurred. Call from hook layer when any of the 3 triggers fire.
 */
export function onNoteTrigger(sessionId: string, trigger: NoteNudgeTrigger): void {
    const state = getState(sessionId);
    state.triggerPending = true;
    sessionLog(sessionId, `note-nudge: trigger fired (${trigger}), triggerPending=true`);
}

/**
 * Peek at whether a note nudge should be injected during this transform pass.
 * Returns the nudge text if yes, null if no.
 * Does NOT clear triggerPending — call markNoteNudgeDelivered() after successful placement.
 */
export function peekNoteNudgeText(db: Database, sessionId: string): string | null {
    const state = getState(sessionId);

    if (!state.triggerPending) return null;

    // Check if there are actually notes to remind about
    const notes = getSessionNotes(db, sessionId);
    if (notes.length === 0) {
        sessionLog(sessionId, "note-nudge: triggerPending but no notes found, skipping");
        return null;
    }

    sessionLog(sessionId, `note-nudge: delivering nudge for ${notes.length} notes`);
    const plural = notes.length === 1 ? "note" : "notes";
    return `You have ${notes.length} deferred ${plural}. Review with ctx_note read — some may be actionable now.`;
}

/**
 * Mark the note nudge as delivered after successful placement.
 * Only call after appendReminderToLatestUserMessage returns a truthy anchor.
 */
export function markNoteNudgeDelivered(sessionId: string): void {
    const state = getState(sessionId);
    state.triggerPending = false;
    state.nudgeDelivered = true;
    sessionLog(sessionId, "note-nudge: marked delivered");
}

/**
 * Legacy wrapper — peek + mark in one call.
 * Kept for existing tests; prefer peekNoteNudgeText + markNoteNudgeDelivered in production.
 */
export function getNoteNudgeText(db: Database, sessionId: string): string | null {
    const text = peekNoteNudgeText(db, sessionId);
    if (text) markNoteNudgeDelivered(sessionId);
    return text;
}

/**
 * Call when session is deleted to clean up in-memory state.
 */
export function clearNoteNudgeState(sessionId: string): void {
    stateBySession.delete(sessionId);
}
