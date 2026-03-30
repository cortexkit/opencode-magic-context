import { createResource, For, Show } from "solid-js";
import type { DreamQueueEntry, DreamStateEntry } from "../../lib/types";
import { getDreamQueue, getDreamState, enqueueDream, getProjects, formatRelativeTime, formatDateTime } from "../../lib/api";

export default function DreamerPanel() {
  const [queue, { refetch: refetchQueue }] = createResource(getDreamQueue);
  const [state, { refetch: refetchState }] = createResource(getDreamState);
  const [projects] = createResource(getProjects);

  /** Extract project identities from dream state `last_dream_at:<identity>` keys. */
  const knownProjectIds = () => {
    const s = state() ?? [];
    return s
      .filter((e) => e.key.startsWith("last_dream_at:"))
      .map((e) => e.key.replace("last_dream_at:", ""));
  };

  const handleRunNow = async () => {
    // Try to enqueue all known projects, or fall back to projects from DB
    let ids = knownProjectIds();
    if (ids.length === 0) {
      ids = (projects() ?? []).map((p) => p.identity);
    }
    if (ids.length === 0) return; // nothing to dream about
    for (const id of ids) {
      await enqueueDream(id, "Manual trigger from dashboard");
    }
    refetchQueue();
  };

  const leaseState = () => {
    const s = state() ?? [];
    const leaseEntry = s.find((e) => e.key === "lease_holder");
    const lastRunEntry = s.find((e) => e.key === "last_run_time");
    return {
      leaseHolder: leaseEntry?.value ?? "none",
      lastRunTime: lastRunEntry?.value ?? null,
    };
  };

  const pendingQueue = () => (queue() ?? []).filter((e) => !e.started_at);
  const completedQueue = () => (queue() ?? []).filter((e) => e.started_at);

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Dreamer</h1>
        <div class="section-actions">
          <button class="btn primary sm" onClick={handleRunNow}>▶ Run Now</button>
          <button class="btn sm" onClick={() => { refetchQueue(); refetchState(); }}>↻ Refresh</button>
        </div>
      </div>

      {/* Status banner */}
      <div style={{ padding: "0 20px 12px" }}>
        <div class="stat-banner">
          <div class="stat-item">
            <span class="stat-label">State</span>
            <span class="stat-value">{leaseState().leaseHolder === "none" ? "idle" : "running"}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Lease</span>
            <span class="stat-value">{leaseState().leaseHolder}</span>
          </div>
          <Show when={leaseState().lastRunTime}>
            <div class="stat-item">
              <span class="stat-label">Last Run</span>
              <span class="stat-value">{(() => {
                const v = leaseState().lastRunTime;
                if (!v) return "—";
                const n = Number(v);
                return !Number.isNaN(n) && n > 1e12 ? formatDateTime(n) : v;
              })()}</span>
            </div>
          </Show>
          <div class="stat-item">
            <span class="stat-label">Queue</span>
            <span class="stat-value">{pendingQueue().length} pending</span>
          </div>
        </div>
      </div>

      <div class="scroll-area">
        {/* Pending queue */}
        <Show when={pendingQueue().length > 0}>
          <div class="category-header">Queue <span class="category-count">({pendingQueue().length})</span></div>
          <div class="list-gap" style={{ "margin-bottom": "16px" }}>
            <For each={pendingQueue()}>
              {(entry) => (
                <div class="card">
                  <div class="card-title">
                    <span class="pill amber">pending</span>
                    <span style={{ "margin-left": "8px" }}>{entry.reason}</span>
                  </div>
                  <div class="card-meta">
                    <span>Project: {entry.project_path}</span>
                    <span>·</span>
                    <span>Queued: {formatRelativeTime(entry.enqueued_at)}</span>
                    <Show when={entry.retry_count > 0}>
                      <span>· Retries: {entry.retry_count}</span>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Dream state entries */}
        <Show when={(state() ?? []).length > 0}>
          <div class="category-header">State <span class="category-count">({state()!.length})</span></div>
          <div style={{ "margin-bottom": "16px" }}>
            <table class="kv-table">
              <tbody>
                <For each={state() ?? []}>
                  {(entry) => {
                    const displayValue = () => {
                      const v = entry.value;
                      // Format epoch-ms timestamps (last_dream_at:*, lease timestamps, etc.)
                      if (entry.key.startsWith("last_dream_at") || entry.key.includes("time")) {
                        const n = Number(v);
                        if (!Number.isNaN(n) && n > 1e12) {
                          return `${formatDateTime(n)} (${formatRelativeTime(n)})`;
                        }
                      }
                      return v;
                    };
                    return (
                      <tr>
                        <td>{entry.key}</td>
                        <td>{displayValue()}</td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        {/* History */}
        <Show when={completedQueue().length > 0}>
          <div class="category-header">History <span class="category-count">({completedQueue().length})</span></div>
          <div class="list-gap">
            <For each={completedQueue()}>
              {(entry) => (
                <div class="card">
                  <div class="card-title">
                    <span class="pill green">completed</span>
                    <span style={{ "margin-left": "8px" }}>{entry.reason}</span>
                  </div>
                  <div class="card-meta">
                    <span>Project: {entry.project_path}</span>
                    <span>·</span>
                    <span>Started: {formatRelativeTime(entry.started_at!)}</span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={(queue() ?? []).length === 0 && (state() ?? []).length === 0}>
          <div class="empty-state">
            <span class="empty-state-icon">🌙</span>
            <span>No dreamer activity</span>
            <span style={{ "font-size": "11px" }}>
              Click "Run Now" to queue a dream task
            </span>
          </div>
        </Show>
      </div>
    </>
  );
}
