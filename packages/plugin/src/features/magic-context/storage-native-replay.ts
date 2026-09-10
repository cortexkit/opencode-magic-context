import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import { ensureSessionMetaRow } from "./storage-meta-shared";

const NATIVE_TOOL_INPUTS_COLUMN = "pi_native_tool_inputs";
const NATIVE_REASONING_IDS_COLUMN = "pi_native_reasoning_ids";

function invalidPersistedReplayState(column: string, sessionId: string): Error {
    return new Error(`invalid persisted ${column} state for session ${sessionId}`);
}

function assertNonEmptyId(
    value: unknown,
    column: string,
    sessionId: string,
): asserts value is string {
    if (typeof value !== "string" || value.length === 0) {
        throw invalidPersistedReplayState(column, sessionId);
    }
}

function assertSerializedToolInput(value: unknown, sessionId: string): asserts value is string {
    if (typeof value !== "string") {
        throw invalidPersistedReplayState(NATIVE_TOOL_INPUTS_COLUMN, sessionId);
    }
    try {
        if (!isRecord(JSON.parse(value))) {
            throw new SyntaxError("native tool input must be an object");
        }
    } catch {
        throw invalidPersistedReplayState(NATIVE_TOOL_INPUTS_COLUMN, sessionId);
    }
}

function parseNativeToolInputs(raw: unknown, sessionId: string): Map<string, string> {
    if (raw === null || raw === undefined) return new Map();
    if (typeof raw !== "string") {
        throw invalidPersistedReplayState(NATIVE_TOOL_INPUTS_COLUMN, sessionId);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw invalidPersistedReplayState(NATIVE_TOOL_INPUTS_COLUMN, sessionId);
    }
    if (!isRecord(parsed)) {
        throw invalidPersistedReplayState(NATIVE_TOOL_INPUTS_COLUMN, sessionId);
    }

    const inputs = new Map<string, string>();
    for (const [id, input] of Object.entries(parsed)) {
        assertNonEmptyId(id, NATIVE_TOOL_INPUTS_COLUMN, sessionId);
        assertSerializedToolInput(input, sessionId);
        inputs.set(id, input);
    }
    return inputs;
}

function parseNativeReasoningIds(raw: unknown, sessionId: string): Set<string> {
    if (raw === null || raw === undefined) return new Set();
    if (typeof raw !== "string") {
        throw invalidPersistedReplayState(NATIVE_REASONING_IDS_COLUMN, sessionId);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw invalidPersistedReplayState(NATIVE_REASONING_IDS_COLUMN, sessionId);
    }
    if (!Array.isArray(parsed)) {
        throw invalidPersistedReplayState(NATIVE_REASONING_IDS_COLUMN, sessionId);
    }

    const ids = new Set<string>();
    for (const id of parsed) {
        assertNonEmptyId(id, NATIVE_REASONING_IDS_COLUMN, sessionId);
        ids.add(id);
    }
    return ids;
}

/**
 * Return frozen native tool inputs. Missing legacy state is empty; malformed
 * stored state is rejected so replay never silently authorizes new bytes.
 */
export function getNativeToolInputs(db: Database, sessionId: string): Map<string, string> {
    const row = db
        .prepare(`SELECT ${NATIVE_TOOL_INPUTS_COLUMN} FROM session_meta WHERE session_id = ?`)
        .get(sessionId) as { pi_native_tool_inputs?: unknown } | undefined;
    return parseNativeToolInputs(row?.pi_native_tool_inputs, sessionId);
}

/**
 * Atomically merge frozen native tool inputs. A supplied call id deliberately
 * replaces its prior serialized input on an authorized cache-busting pass;
 * values for every other call id remain intact.
 */
export function saveNativeToolInputs(
    db: Database,
    sessionId: string,
    inputs: ReadonlyMap<string, string>,
): void {
    for (const [id, input] of inputs) {
        assertNonEmptyId(id, NATIVE_TOOL_INPUTS_COLUMN, sessionId);
        assertSerializedToolInput(input, sessionId);
    }

    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const row = db
            .prepare(`SELECT ${NATIVE_TOOL_INPUTS_COLUMN} FROM session_meta WHERE session_id = ?`)
            .get(sessionId) as { pi_native_tool_inputs?: unknown } | undefined;
        const current = parseNativeToolInputs(row?.pi_native_tool_inputs, sessionId);
        let changed = false;
        for (const [id, input] of inputs) {
            if (current.get(id) === input) continue;
            current.set(id, input);
            changed = true;
        }
        if (!changed) return;

        const result = db
            .prepare(
                `UPDATE session_meta SET ${NATIVE_TOOL_INPUTS_COLUMN} = ? WHERE session_id = ?`,
            )
            .run(JSON.stringify(Object.fromEntries(current)), sessionId);
        if (result.changes !== 1) {
            throw new Error(
                `failed to persist ${NATIVE_TOOL_INPUTS_COLUMN} for session ${sessionId}`,
            );
        }
    }).immediate();
}

/**
 * Return assistant entries whose native reasoning was cleared. Missing legacy
 * state is empty; malformed stored state fails closed.
 */
export function getNativeReasoningIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare(`SELECT ${NATIVE_REASONING_IDS_COLUMN} FROM session_meta WHERE session_id = ?`)
        .get(sessionId) as { pi_native_reasoning_ids?: unknown } | undefined;
    return parseNativeReasoningIds(row?.pi_native_reasoning_ids, sessionId);
}

/** Atomically union newly cleared native-reasoning entry ids into the replay set. */
export function addNativeReasoningIds(
    db: Database,
    sessionId: string,
    ids: Iterable<string>,
): void {
    const requested = new Set<string>();
    for (const id of ids) {
        assertNonEmptyId(id, NATIVE_REASONING_IDS_COLUMN, sessionId);
        requested.add(id);
    }

    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const row = db
            .prepare(`SELECT ${NATIVE_REASONING_IDS_COLUMN} FROM session_meta WHERE session_id = ?`)
            .get(sessionId) as { pi_native_reasoning_ids?: unknown } | undefined;
        const current = parseNativeReasoningIds(row?.pi_native_reasoning_ids, sessionId);
        let changed = false;
        for (const id of requested) {
            if (current.has(id)) continue;
            current.add(id);
            changed = true;
        }
        if (!changed) return;

        const result = db
            .prepare(
                `UPDATE session_meta SET ${NATIVE_REASONING_IDS_COLUMN} = ? WHERE session_id = ?`,
            )
            .run(JSON.stringify([...current]), sessionId);
        if (result.changes !== 1) {
            throw new Error(
                `failed to persist ${NATIVE_REASONING_IDS_COLUMN} for session ${sessionId}`,
            );
        }
    }).immediate();
}
