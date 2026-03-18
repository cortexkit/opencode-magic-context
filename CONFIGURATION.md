# Configuration Reference

All settings are flat top-level keys in `magic-context.jsonc`. Create the file in your project root, `.opencode/magic-context.jsonc`, or `~/.config/opencode/magic-context.jsonc` for user-wide defaults. Project config merges on top of user config.

---

## Cache Awareness

LLM providers cache conversation prefixes server-side. The cache window depends on your provider and subscription tier — Claude Pro offers 5 minutes, Max offers 1 hour, and pricing for cached vs. uncached tokens differs between API and subscription usage.

Magic Context defers all mutations until the cached prefix expires. The default `cache_ttl` of `"5m"` matches most providers. You can tune it:

```jsonc
{
  "cache_ttl": "5m"
}
```

Per-model overrides for mixed-model workflows:

```jsonc
{
  "cache_ttl": {
    "default": "5m",
    "anthropic/claude-opus-4-6": "60m"
  }
}
```

Supported formats: `"30s"`, `"5m"`, `"1h"`.

Higher-tier models with longer cache windows benefit from a longer TTL. Setting it too low wastes cache hits. Setting it too high delays reduction on long sessions.

---

## Core

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Master toggle. |
| `cache_ttl` | `string` or `object` | `"5m"` | Time after a response before applying pending ops. String or per-model map. |
| `protected_tags` | `number` (1–20) | `5` | Last N active tags immune from immediate dropping. |
| `nudge_interval_tokens` | `number` | `10000` | Minimum token growth between rolling nudges. |
| `execute_threshold_percentage` | `number` (35–95) or `object` | `65` | Context usage that forces queued ops to execute. Supports per-model map. |
| `auto_drop_tool_age` | `number` | `100` | Auto-drop tool outputs older than N tags during execution. |
| `clear_reasoning_age` | `number` | `50` | Clear thinking/reasoning blocks older than N tags. |
| `iteration_nudge_threshold` | `number` | `15` | Consecutive assistant turns without user input before an iteration nudge. |
| `compartment_token_budget` | `number` | `20000` | Token budget for historian input chunks. |
| `historian_timeout_ms` | `number` | `300000` | Timeout per historian call (ms). |

---

## `historian`

Configures the background historian. Optional — the plugin has a built-in default chain.

```jsonc
{
  "historian": {
    "model": "anthropic/claude-haiku-4",
    "fallback_models": ["anthropic/claude-3-5-haiku"],
    "temperature": 0.1,
    "maxTokens": 4096
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Primary model. |
| `fallback_models` | `string` or `string[]` | Models to try if the primary fails or is rate-limited. |
| `temperature` | `number` (0–2) | Sampling temperature. |
| `maxTokens` | `number` | Max tokens per response. |
| `variant` | `string` | Agent variant. |
| `prompt` | `string` | Custom system prompt override. |

---

## `embedding`

Controls semantic search for cross-session memories.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `"local"` \| `"openai-compatible"` \| `"off"` | `"local"` | `"local"` runs `Xenova/all-MiniLM-L6-v2` in-process. |
| `model` | `string` | `"Xenova/all-MiniLM-L6-v2"` | Embedding model. |
| `endpoint` | `string` | — | Required for `"openai-compatible"`. |
| `api_key` | `string` | — | Optional API key for remote endpoints. |

```jsonc
{
  "embedding": {
    "provider": "openai-compatible",
    "model": "text-embedding-3-small",
    "endpoint": "https://api.openai.com/v1",
    "api_key": "sk-..."
  }
}
```

---

## `memory`

Cross-session memory settings. All memories are scoped to the current project (identified by git root commit hash).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable cross-session memory. |
| `injection_budget_tokens` | `number` (500–20000) | `4000` | Token budget for memory injection. |
| `auto_promote` | `boolean` | `true` | Promote eligible session facts to memory automatically. |
| `retrieval_count_promotion_threshold` | `number` | `3` | Retrievals needed before a memory is auto-promoted to permanent. |

---

## `sidekick`

Optional lightweight local agent for memory retrieval augmentation. Disabled by default.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable sidekick. |
| `endpoint` | `string` | `"http://localhost:1234/v1"` | OpenAI-compatible endpoint. |
| `model` | `string` | `"qwen3.5-9b"` | Model for sidekick queries. |
| `api_key` | `string` | `""` | API key if needed. |
| `max_tool_calls` | `number` | `3` | Max tool calls per retrieval. |
| `timeout_ms` | `number` | `30000` | Timeout per run (ms). |
| `system_prompt` | `string` | — | Custom system prompt override. |

---

## `dreaming`

Background memory maintenance on a schedule (typically overnight). Requires a local LLM.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable dreaming. |
| `schedule` | `string` | `"02:00-06:00"` | Time window (24h format). |
| `max_runtime_minutes` | `number` | `120` | Max runtime per session. |
| `endpoint` | `string` | `"http://localhost:1234/v1"` | OpenAI-compatible endpoint. |
| `model` | `string` | `"qwen3.5-32b"` | Model for dreaming tasks. |
| `api_key` | `string` | `""` | API key if needed. |
| `tasks` | `array` | `["decay", "consolidate"]` | Tasks to run: `"decay"`, `"consolidate"`, `"mine"`, `"verify"`, `"git"`, `"map"`. |

---

## Full example

```jsonc
{
  "enabled": true,
  "cache_ttl": "5m",
  "protected_tags": 5,
  "execute_threshold_percentage": 65,

  "historian": {
    "model": "anthropic/claude-haiku-4",
    "fallback_models": ["anthropic/claude-3-5-haiku"]
  },

  "embedding": {
    "provider": "local"
  },

  "memory": {
    "enabled": true,
    "injection_budget_tokens": 4000,
    "auto_promote": true
  },

  "dreaming": {
    "enabled": false,
    "schedule": "02:00-06:00",
    "model": "qwen3.5-32b",
    "tasks": ["decay", "consolidate"]
  }
}
```
