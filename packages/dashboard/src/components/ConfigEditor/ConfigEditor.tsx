import { createSignal, createResource, Show, For, createMemo } from "solid-js";
import type { ProjectConfigEntry } from "../../lib/types";
import { getConfig, saveConfig, getProjectConfigs, saveProjectConfig } from "../../lib/api";

// ── JSONC helpers ───────────────────────────────────────────

// Minimal JSONC parser: strip single-line and block comments, then parse.
function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  try {
    return JSON.parse(stripped);
  } catch {
    return {};
  }
}

/** Pretty-print config as JSONC (plain JSON with 2-space indent). */
function toJsonc(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2);
}

// ── Config field definitions ────────────────────────────────

interface FieldDef {
  key: string;
  label: string;
  type: "boolean" | "number" | "string" | "select";
  options?: string[];
  description: string;
  section: string;
}

const FIELD_DEFS: FieldDef[] = [
  // General
  { key: "enabled", label: "Enabled", type: "boolean", description: "Enable the magic-context plugin", section: "General" },
  { key: "ctx_reduce_enabled", label: "ctx_reduce Enabled", type: "boolean", description: "Enable ctx_reduce tool and nudges. When false, only heuristic cleanup and compartments manage context.", section: "General" },
  // Thresholds
  { key: "cache_ttl", label: "Cache TTL", type: "string", description: "How long to wait before executing queued operations (e.g. '5m', '59m'). Can also be { default: '5m', 'model-key': '59m' }.", section: "Thresholds" },
  { key: "execute_threshold_percentage", label: "Execute Threshold %", type: "number", description: "Context usage percentage (35–80) at which queued drops execute. Max 80.", section: "Thresholds" },
  { key: "nudge_interval_tokens", label: "Nudge Interval (tokens)", type: "number", description: "Token interval between rolling ctx_reduce nudges.", section: "Thresholds" },
  // Tags & cleanup
  { key: "protected_tags", label: "Protected Tags", type: "number", description: "Number of recent tags protected from drops.", section: "Tags & Cleanup" },
  { key: "auto_drop_tool_age", label: "Auto Drop Tool Age", type: "number", description: "Tag age after which tool outputs are automatically dropped.", section: "Tags & Cleanup" },
  { key: "clear_reasoning_age", label: "Clear Reasoning Age", type: "number", description: "Tag age after which reasoning blocks are cleared.", section: "Tags & Cleanup" },
  { key: "iteration_nudge_threshold", label: "Iteration Nudge Threshold", type: "number", description: "Number of consecutive tool calls before showing an iteration nudge.", section: "Tags & Cleanup" },
  // Historian
  { key: "compartment_token_budget", label: "Compartment Token Budget", type: "number", description: "Max tokens per historian chunk input.", section: "Historian" },
  { key: "history_budget_percentage", label: "History Budget %", type: "number", description: "Fraction of context limit reserved for rendered history (0.0–1.0).", section: "Historian" },
  { key: "historian_timeout_ms", label: "Historian Timeout (ms)", type: "number", description: "Max wait time for a historian run before timeout.", section: "Historian" },
  // Embedding
  { key: "embedding.provider", label: "Embedding Provider", type: "select", options: ["local", "openai-compatible", "off"], description: "Which embedding provider to use for memory search.", section: "Embedding" },
  { key: "embedding.model", label: "Embedding Model", type: "string", description: "Model name for embeddings. Defaults to Xenova/all-MiniLM-L6-v2 for local.", section: "Embedding" },
  { key: "embedding.endpoint", label: "Embedding Endpoint", type: "string", description: "API endpoint for openai-compatible provider.", section: "Embedding" },
  // Memory
  { key: "memory.enabled", label: "Memory Enabled", type: "boolean", description: "Enable cross-session project memory.", section: "Memory" },
  { key: "memory.injection_budget_tokens", label: "Injection Budget (tokens)", type: "number", description: "Max tokens for memory injection into session history.", section: "Memory" },
  { key: "memory.auto_promote", label: "Auto Promote", type: "boolean", description: "Automatically promote session facts to project memory.", section: "Memory" },
];

// ── Nested value access helpers ─────────────────────────────

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const clone = structuredClone(obj);
  const parts = path.split(".");
  let current: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return clone;
}

// ── Section icons ───────────────────────────────────────────

const SECTION_ICONS: Record<string, string> = {
  "General": "⚙️",
  "Thresholds": "⚡",
  "Tags & Cleanup": "🏷️",
  "Historian": "📜",
  "Embedding": "🔗",
  "Memory": "🧠",
};

// Fields that should use range sliders (percentage or threshold values)
const RANGE_SLIDER_FIELDS = new Set([
  "execute_threshold_percentage",
  "history_budget_percentage",
  "nudge_interval_tokens",
  "protected_tags",
  "auto_drop_tool_age",
  "clear_reasoning_age",
  "iteration_nudge_threshold",
  "compartment_token_budget",
  "historian_timeout_ms",
  "memory.injection_budget_tokens",
]);

// ── ConfigForm component ────────────────────────────────────

function ConfigForm(props: {
  content: string;
  onSave: (content: string) => void;
  saveStatus: string | null;
}) {
  const [showRaw, setShowRaw] = createSignal(false);
  const [rawEdit, setRawEdit] = createSignal<string | null>(null);
  const [formData, setFormData] = createSignal<Record<string, unknown>>(parseJsonc(props.content));

  // Reset form data when content prop changes
  const parsed = createMemo(() => parseJsonc(props.content));

  const sections = createMemo(() => {
    const groups: Record<string, FieldDef[]> = {};
    for (const field of FIELD_DEFS) {
      if (!groups[field.section]) groups[field.section] = [];
      groups[field.section].push(field);
    }
    return Object.entries(groups);
  });

  const handleFieldChange = (key: string, value: unknown) => {
    const updated = setNestedValue(formData(), key, value);
    setFormData(updated);
  };

  const handleFormSave = () => {
    // Merge form data with original to preserve unknown keys
    const original = parsed();
    const merged = { ...original, ...formData() };
    // Deep merge for nested objects
    for (const key of ["embedding", "memory"]) {
      if (typeof formData()[key] === "object" && formData()[key] != null) {
        merged[key] = { ...(original[key] as Record<string, unknown> ?? {}), ...(formData()[key] as Record<string, unknown>) };
      }
    }
    props.onSave(toJsonc(merged));
  };

  const handleRawSave = () => {
    const content = rawEdit();
    if (content != null) {
      props.onSave(content);
      setRawEdit(null);
      setFormData(parseJsonc(content));
    }
  };

  // Range slider helpers
  const getRangeConfig = (fieldKey: string): { min: number; max: number; step: number; suffix: string; defaultValue: number } => {
    switch (fieldKey) {
      case "execute_threshold_percentage":
        return { min: 35, max: 80, step: 1, suffix: "%", defaultValue: 65 };
      case "history_budget_percentage":
        return { min: 0.05, max: 0.5, step: 0.01, suffix: "", defaultValue: 0.15 };
      case "nudge_interval_tokens":
        return { min: 1000, max: 50000, step: 1000, suffix: " tokens", defaultValue: 10000 };
      case "protected_tags":
        return { min: 1, max: 20, step: 1, suffix: "", defaultValue: 20 };
      case "auto_drop_tool_age":
        return { min: 10, max: 200, step: 5, suffix: "", defaultValue: 100 };
      case "clear_reasoning_age":
        return { min: 10, max: 200, step: 5, suffix: "", defaultValue: 50 };
      case "iteration_nudge_threshold":
        return { min: 5, max: 30, step: 1, suffix: "", defaultValue: 15 };
      case "compartment_token_budget":
        return { min: 10000, max: 100000, step: 5000, suffix: " tokens", defaultValue: 20000 };
      case "historian_timeout_ms":
        return { min: 60000, max: 600000, step: 30000, suffix: " ms", defaultValue: 300000 };
      case "memory.injection_budget_tokens":
        return { min: 500, max: 20000, step: 500, suffix: " tokens", defaultValue: 4000 };
      default:
        return { min: 0, max: 100, step: 1, suffix: "", defaultValue: 0 };
    }
  };

  return (
    <div>
      {/* Sticky Action Bar */}
      <div class="config-action-bar">
        <div class="tab-pills" style={{ margin: "0" }}>
          <button class={`tab-pill ${!showRaw() ? "active" : ""}`} onClick={() => setShowRaw(false)}>Form</button>
          <button class={`tab-pill ${showRaw() ? "active" : ""}`} onClick={() => { setShowRaw(true); setRawEdit(null); }}>Raw JSONC</button>
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
          <Show when={props.saveStatus}>
            <span style={{ "font-size": "12px", color: props.saveStatus!.startsWith("✓") ? "var(--green)" : "var(--red)" }}>
              {props.saveStatus}
            </span>
          </Show>
          <button class="btn primary sm" onClick={handleFormSave}>Save Changes</button>
        </div>
      </div>

      <Show when={!showRaw()} fallback={
        <div>
          <Show when={rawEdit() != null} fallback={
            <div>
              <pre class="config-pre">{props.content || "// Empty config"}</pre>
              <div style={{ "margin-top": "12px" }}>
                <button class="btn sm" onClick={() => setRawEdit(props.content)}>Edit</button>
              </div>
            </div>
          }>
            <textarea
              class="code-editor"
              style={{ "min-height": "calc(100vh - 340px)" }}
              value={rawEdit()!}
              onInput={(e) => setRawEdit(e.currentTarget.value)}
            />
            <div style={{ display: "flex", gap: "8px", "margin-top": "12px" }}>
              <button class="btn primary sm" onClick={handleRawSave}>Save</button>
              <button class="btn sm" onClick={() => setRawEdit(null)}>Cancel</button>
            </div>
          </Show>
        </div>
      }>
        <div class="config-grid">
          <For each={sections()}>
            {([sectionName, fields]) => {
              const isFullWidth = sectionName === "Embedding";
              return (
                <div class={`config-card ${isFullWidth ? "full-width" : ""}`}>
                  <div class="config-card-header">
                    <span class="config-card-icon">{SECTION_ICONS[sectionName] || "📋"}</span>
                    <span class="config-card-title">{sectionName}</span>
                  </div>
                  <div class="config-card-content">
                    <For each={fields}>
                      {(field) => {
                        const value = () => {
                          const formVal = getNestedValue(formData(), field.key);
                          return formVal !== undefined ? formVal : getNestedValue(parsed(), field.key);
                        };

                        // For fields that can be objects (e.g. { default: 65, "model-key": 80 }),
                        // extract the scalar value for display/editing
                        const scalarValue = () => {
                          const v = value();
                          if (v != null && typeof v === "object" && !Array.isArray(v)) {
                            const obj = v as Record<string, unknown>;
                            return obj.default !== undefined ? obj.default : undefined;
                          }
                          return v;
                        };
                        const isObjectValue = () => {
                          const v = value();
                          return v != null && typeof v === "object" && !Array.isArray(v);
                        };
                        const isRangeSlider = field.type === "number" && RANGE_SLIDER_FIELDS.has(field.key) && !isObjectValue();

                        return (
                          <div class="config-field">
                            <div class="config-field-header">
                              <label class="config-field-label">{field.label}</label>
                              <span class="config-field-key">{field.key}</span>
                            </div>
                            <span class="config-field-desc">{field.description}</span>

                            {field.type === "boolean" ? (
                              <label class="toggle-switch">
                                <input
                                  type="checkbox"
                                  checked={value() as boolean ?? true}
                                  onChange={(e) => handleFieldChange(field.key, e.currentTarget.checked)}
                                />
                                <span class="toggle-slider" />
                                <span class="toggle-label">{(value() as boolean ?? true) ? "Enabled" : "Disabled"}</span>
                              </label>
                            ) : field.type === "select" ? (
                              <select
                                class="config-input"
                                value={String(value() ?? "")}
                                onChange={(e) => handleFieldChange(field.key, e.currentTarget.value)}
                              >
                                <For each={field.options ?? []}>
                                  {(opt) => <option value={opt}>{opt}</option>}
                                </For>
                              </select>
                            ) : isRangeSlider ? (
                              <div class="range-slider-container">
                                <input
                                  class="range-slider"
                                  type="range"
                                  min={getRangeConfig(field.key).min}
                                  max={getRangeConfig(field.key).max}
                                  step={getRangeConfig(field.key).step}
                                  value={scalarValue() != null ? Number(scalarValue()) : getRangeConfig(field.key).defaultValue}
                                  onInput={(e) => handleFieldChange(field.key, Number(e.currentTarget.value))}
                                />
                                <span class="range-slider-value">
                                  {scalarValue() != null ? Number(scalarValue()) : getRangeConfig(field.key).defaultValue}{getRangeConfig(field.key).suffix}
                                </span>
                              </div>
                            ) : field.type === "number" ? (
                              <input
                                class="config-input"
                                type="number"
                                value={value() != null ? String(value()) : ""}
                                placeholder="default"
                                onInput={(e) => {
                                  const v = e.currentTarget.value;
                                  handleFieldChange(field.key, v ? Number(v) : undefined);
                                }}
                              />
                            ) : (
                              <input
                                class="config-input"
                                type="text"
                                value={typeof value() === "object" ? JSON.stringify(value()) : String(value() ?? "")}
                                placeholder="default"
                                onInput={(e) => handleFieldChange(field.key, e.currentTarget.value)}
                              />
                            )}
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

// ── ProjectConfigDetail ─────────────────────────────────────

function ProjectConfigDetail(props: {
  entry: ProjectConfigEntry;
  onBack: () => void;
}) {
  const configPath = () => props.entry.exists ? props.entry.config_path : (props.entry.alt_exists ? props.entry.alt_config_path! : props.entry.config_path);
  const [config] = createResource(() => configPath(), async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("get_config", { source: "project", projectPath: props.entry.worktree }) as import("../../lib/types").ConfigFile;
  });

  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);

  const handleSave = async (content: string) => {
    try {
      await saveProjectConfig(props.entry.worktree, content);
      setSaveStatus("✓ Saved");
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus(`✕ Error: ${err}`);
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "12px" }}>
        <button class="btn sm" onClick={props.onBack}>← Back</button>
        <span style={{ "font-weight": "600" }}>{props.entry.project_name}</span>
      </div>
      <table class="kv-table" style={{ "margin-bottom": "12px" }}>
        <tbody>
          <tr><td>Path</td><td style={{ "word-break": "break-all" }}>{configPath()}</td></tr>
          <tr><td>Worktree</td><td style={{ "word-break": "break-all" }}>{props.entry.worktree}</td></tr>
        </tbody>
      </table>
      <Show when={config()} fallback={<div class="empty-state">Loading...</div>}>
        <ConfigForm
          content={config()!.content}
          onSave={handleSave}
          saveStatus={saveStatus()}
        />
      </Show>
    </div>
  );
}

// ── Main ConfigEditor ───────────────────────────────────────

export default function ConfigEditor() {
  const [tab, setTab] = createSignal<"user" | "projects">("user");
  const [userConfig, { refetch: refetchUser }] = createResource(() => getConfig("user"));
  const [projectConfigs, { refetch: refetchProjects }] = createResource(getProjectConfigs);
  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);
  const [selectedProject, setSelectedProject] = createSignal<ProjectConfigEntry | null>(null);

  const handleUserSave = async (content: string) => {
    try {
      await saveConfig("user", content);
      setSaveStatus("✓ Saved");
      refetchUser();
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus(`✕ Error: ${err}`);
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Configuration</h1>
        <div class="section-actions">
          <button class="btn sm" onClick={() => { refetchUser(); refetchProjects(); }}>↻ Refresh</button>
        </div>
      </div>

      <div class="tab-pills">
        <button
          class={`tab-pill ${tab() === "user" ? "active" : ""}`}
          onClick={() => { setTab("user"); setSelectedProject(null); }}
        >
          User Config
        </button>
        <button
          class={`tab-pill ${tab() === "projects" ? "active" : ""}`}
          onClick={() => { setTab("projects"); setSelectedProject(null); }}
        >
          Project Configs
          <Show when={(projectConfigs() ?? []).length > 0}>
            <span class="category-count" style={{ "margin-left": "4px" }}>({projectConfigs()!.length})</span>
          </Show>
        </button>
      </div>

      <div class="scroll-area">
        <Show when={tab() === "user"}>
          <Show when={!userConfig.loading} fallback={<div class="empty-state">Loading config...</div>}>
            <div style={{ "margin-bottom": "8px" }}>
              <table class="kv-table">
                <tbody>
                  <tr><td>Path</td><td style={{ "word-break": "break-all" }}>{userConfig()?.path ?? "—"}</td></tr>
                </tbody>
              </table>
            </div>
            <Show when={userConfig()?.exists} fallback={
              <div class="empty-state">
                <span class="empty-state-icon">⚙️</span>
                <span>No user config found at {userConfig()?.path}</span>
                <span style={{ "font-size": "11px" }}>Run <code>bunx @cortexkit/opencode-magic-context setup</code> to create one</span>
              </div>
            }>
              <ConfigForm
                content={userConfig()!.content}
                onSave={handleUserSave}
                saveStatus={saveStatus()}
              />
            </Show>
          </Show>
        </Show>

        <Show when={tab() === "projects"}>
          {selectedProject() ? (
            <ProjectConfigDetail
              entry={selectedProject()!}
              onBack={() => setSelectedProject(null)}
            />
          ) : (projectConfigs() ?? []).length > 0 ? (
            <div class="list-gap">
              <For each={projectConfigs() ?? []}>
                {(entry) => (
                  <div class="card" style={{ cursor: "pointer" }} onClick={() => setSelectedProject(entry)}>
                    <div class="card-title">
                      <span class="pill blue">project</span>
                      <span style={{ "margin-left": "8px", "font-weight": "600" }}>{entry.project_name}</span>
                    </div>
                    <div class="card-meta">
                      <span>{entry.worktree}</span>
                      <span>·</span>
                      <span>{entry.exists ? "magic-context.jsonc" : ".opencode/magic-context.jsonc"}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          ) : (
            <div class="empty-state">
              <span class="empty-state-icon">📁</span>
              <span>No project-level configs found</span>
              <span style={{ "font-size": "11px" }}>
                Create <code>magic-context.jsonc</code> in a project root to add project-specific overrides
              </span>
            </div>
          )}
        </Show>
      </div>
    </>
  );
}
