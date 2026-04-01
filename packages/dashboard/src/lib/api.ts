import { invoke } from "@tauri-apps/api/core";
import type {
  Memory,
  MemoryStats,
  SessionSummary,
  Compartment,
  SessionFact,
  SessionNote,
  SessionMetaRow,
  ContextTokenBreakdown,
  DreamQueueEntry,
  DreamStateEntry,
  LogEntry,
  CacheEvent,
  DbCacheEvent,
  ConfigFile,
  DbHealth,
} from "./types";

// ── Memory API ──────────────────────────────────────────────

export async function getProjects(): Promise<import("./types").ProjectInfo[]> {
  return invoke("get_projects");
}

export async function getMemories(params?: {
  project?: string;
  status?: string;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<Memory[]> {
  return invoke("get_memories", {
    project: params?.project ?? null,
    status: params?.status ?? null,
    category: params?.category ?? null,
    search: params?.search ?? null,
    limit: params?.limit ?? 100,
    offset: params?.offset ?? 0,
  });
}

export async function getMemoryStats(project?: string): Promise<MemoryStats> {
  return invoke("get_memory_stats", { project: project ?? null });
}

export async function updateMemoryStatus(
  memoryId: number,
  status: string
): Promise<void> {
  return invoke("update_memory_status", { memoryId, status });
}

export async function updateMemoryContent(
  memoryId: number,
  content: string
): Promise<void> {
  return invoke("update_memory_content", { memoryId, content });
}

export async function deleteMemory(memoryId: number): Promise<void> {
  return invoke("delete_memory", { memoryId });
}

// ── Session API ─────────────────────────────────────────────

export async function getSessions(): Promise<SessionSummary[]> {
  return invoke("get_sessions");
}

export async function getCompartments(
  sessionId: string
): Promise<Compartment[]> {
  return invoke("get_compartments", { sessionId });
}

export async function getSessionFacts(
  sessionId: string
): Promise<SessionFact[]> {
  return invoke("get_session_facts", { sessionId });
}

export async function getSessionNotes(
  sessionId: string
): Promise<SessionNote[]> {
  return invoke("get_session_notes", { sessionId });
}

export async function getSessionMeta(
  sessionId: string
): Promise<SessionMetaRow | null> {
  return invoke("get_session_meta", { sessionId });
}

export async function getContextTokenBreakdown(
  sessionId: string
): Promise<ContextTokenBreakdown | null> {
  return invoke("get_context_token_breakdown", { sessionId });
}

export async function getSessionCacheStats(
  limit?: number
): Promise<import("./types").SessionCacheStats[]> {
  return invoke("get_session_cache_stats", { maxLines: 5000, limit: limit ?? 5 });
}

export async function getSessionCacheStatsFromDb(
  limit?: number
): Promise<import("./types").SessionCacheStats[]> {
  return invoke("get_session_cache_stats_from_db", { limit: limit ?? 5 });
}

// ── Dreamer API ─────────────────────────────────────────────

export async function getDreamQueue(): Promise<DreamQueueEntry[]> {
  return invoke("get_dream_queue");
}

export async function getDreamState(): Promise<DreamStateEntry[]> {
  return invoke("get_dream_state");
}

export async function enqueueDream(
  projectPath: string,
  reason: string
): Promise<number> {
  return invoke("enqueue_dream", { projectPath, reason });
}

// ── Log & Cache API ─────────────────────────────────────────

export async function getLogEntries(
  maxLines?: number
): Promise<LogEntry[]> {
  return invoke("get_log_entries", { maxLines: maxLines ?? 500 });
}

export async function getCacheEvents(
  maxLines?: number
): Promise<CacheEvent[]> {
  return invoke("get_cache_events", { maxLines: maxLines ?? 2000 });
}

export async function getCacheEventsFromDb(
  limit?: number,
  sinceTimestamp?: number | null
): Promise<DbCacheEvent[]> {
  return invoke("get_cache_events_from_db", {
    limit: limit ?? 200,
    sinceTimestamp: sinceTimestamp ?? null,
  });
}

// ── Config API ──────────────────────────────────────────────

export async function getConfig(source: string): Promise<ConfigFile> {
  return invoke("get_config", { source });
}

export async function saveConfig(
  source: string,
  content: string
): Promise<void> {
  return invoke("save_config", { source, content });
}

// ── Health API ──────────────────────────────────────────────

export async function getDbHealth(): Promise<DbHealth> {
  return invoke("get_db_health");
}

export async function getProjectConfigs(): Promise<import("./types").ProjectConfigEntry[]> {
  return invoke("get_project_configs");
}

export async function saveProjectConfig(
  projectPath: string,
  content: string,
): Promise<void> {
  return invoke("save_project_config", { projectPath, content });
}

export async function getAvailableModels(): Promise<string[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("get_available_models");
}

// ── Utilities ───────────────────────────────────────────────

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const month = d.toLocaleString("en", { month: "short" });
  return `${month} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}
