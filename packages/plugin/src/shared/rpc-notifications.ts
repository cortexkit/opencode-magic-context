/**
 * In-memory notification queue for server→TUI push.
 * Replaces SQLite plugin_messages table.
 *
 * Also tracks whether a TUI client is actively connected (polling).
 * The server plugin cannot use `process.env.OPENCODE_CLIENT` to detect TUI
 * because the server runs in a separate process from the TUI client.
 */

export interface RpcNotification {
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}

let queue: RpcNotification[] = [];
let tuiConnected = false;

/** Push a notification for TUI to pick up via polling. */
export function pushNotification(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
): void {
    queue.push({ type, payload, sessionId });
    // Cap queue size to prevent unbounded growth if TUI is not polling
    if (queue.length > 100) {
        queue = queue.slice(-50);
    }
}

/** Drain and return all pending notifications atomically.
 *  Also marks TUI as connected since only TUI polls this. */
export function drainNotifications(): RpcNotification[] {
    tuiConnected = true;
    const result = queue;
    queue = [];
    return result;
}

/** Whether a TUI client has connected and is polling for notifications. */
export function isTuiConnected(): boolean {
    return tuiConnected;
}
