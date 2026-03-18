# Transform Architecture

This document describes the internal architecture of Magic Context's message transform pipeline — the core mechanism that rewrites OpenCode's conversation history on every turn to manage context size, inject durable state, and communicate with the agent. Every design decision is shaped by one constraint: **avoid busting the LLM provider's cached conversation prefix unless absolutely necessary.**

---

## Table of Contents

1. [Hook Registration](#hook-registration)
2. [Transform Lifecycle](#transform-lifecycle)
3. [Cache Model](#cache-model)
4. [Tagging](#tagging)
5. [Scheduler: Execute vs Defer](#scheduler-execute-vs-defer)
6. [Pending Operations](#pending-operations)
7. [Heuristic Cleanup](#heuristic-cleanup)
8. [Compartment Injection](#compartment-injection)
9. [Memory Injection](#memory-injection)
10. [Dropped Placeholder Stripping](#dropped-placeholder-stripping)
11. [Sticky Turn Reminders](#sticky-turn-reminders)
12. [Nudging](#nudging)
13. [Nudge Anchor Stability](#nudge-anchor-stability)
14. [Emergency Nudge](#emergency-nudge)
15. [System Prompt Hash Detection](#system-prompt-hash-detection)
16. [Variant Change Flush](#variant-change-flush)
17. [Compartment Trigger Heuristics](#compartment-trigger-heuristics)
18. [Historian Lifecycle](#historian-lifecycle)
19. [Reduced Mode (Subagent Sessions)](#reduced-mode-subagent-sessions)
20. [Tool Execute After Hook](#tool-execute-after-hook)
21. [Event Handler](#event-handler)
22. [In-Memory State Maps](#in-memory-state-maps)
23. [Ordering Constraints](#ordering-constraints)

---

## Hook Registration

Magic Context registers six hooks with OpenCode, returned from `createMagicContextHook()` in `hook.ts`:

| Hook | OpenCode slot | Purpose |
|------|---------------|---------|
| **Messages transform** | `experimental.chat.messages.transform` | Core pipeline — tagging, mutations, injection, nudging |
| **System prompt transform** | `experimental.chat.system.transform` | Inject agent guidance, detect system prompt changes |
| **Chat message** | `chat.message` | Fires on each new user message — sticky reminders, variant tracking |
| **Event** | `event` | Context usage tracking, emergency nudge, session lifecycle |
| **Command execute before** | `command.execute.before` | `/ctx-status`, `/ctx-flush`, `/ctx-recomp` commands |
| **Tool execute after** | `tool.execute.after` | Track `ctx_reduce` calls and tool usage counts |
| **Text complete** | `experimental.text.complete` | Autocomplete support (minimal) |

All hooks share a single `ContextDatabase` (SQLite) handle opened at registration time. If the database cannot be opened or is non-persistent (in-memory), Magic Context disables itself entirely and shows a toast notification.

---

## Transform Lifecycle

The messages transform (`experimental.chat.messages.transform`) runs **on every turn** before the conversation is sent to the LLM. It receives `{ messages: unknown[] }` and mutates the array in place.

### Phase 1: Setup (transform.ts)

```
1. Find sessionId from message metadata
2. Load sessionMeta from DB (fail-open: skip transform on error)
3. Determine mode: full (root sessions) vs reduced (subagents)
4. Prepare compartment injection (read compartments, facts, notes, memories from DB)
5. Tag all messages (assign §N§ identifiers)
6. Apply flushed statuses (pre-flushed drops from /ctx-flush)
7. Strip structural noise (empty parts, orphaned tool results)
8. Strip cleared reasoning blocks
9. Compute watermark (highest dropped tag number)
10. Load context usage from in-memory map
11. Ask scheduler: "execute" or "defer"?
12. Run compartment phase (check triggers, possibly start historian)
```

### Phase 2: Post-transform (transform-postprocess-phase.ts)

```
13. Apply pending operations (if scheduler says "execute" or explicit flush)
14. Apply heuristic cleanup (if conditions met — see below)
15. Watermark cleanup (truncate errored tools, strip processed images)
16. Clear old reasoning (thinking blocks older than N tags)
17. Finalize batch writes
18. Drop stale ctx_reduce calls (after mutations)
19. Render compartment injection (splice synthetic message into array)
20. Strip dropped placeholder messages ([dropped §N§] shells)
21. Handle sticky turn reminders (inject or clear)
22. Compute nudge (rolling, iteration, or none)
23. Apply nudge to anchor message (or find new anchor)
```

The entire pipeline is synchronous except for the compartment phase, which may `await` a historian run if context usage exceeds the blocking threshold (95%).

---

## Cache Model

LLM providers (Anthropic, OpenAI) cache conversation prefixes server-side. The cached prefix is invalidated when **any byte** in the prefix changes. This means:

- **Inserting** content into a message that was part of the cached prefix → cache bust
- **Removing** content from a cached-prefix message → cache bust
- **Appending** new messages after the cached prefix → no cache bust (this is normal conversation growth)
- **Changing** the system prompt → cache bust (the system prompt is part of the prefix)

### Cache-preserving design rules

1. **Queued mutations**: When the agent calls `ctx_reduce`, drops are queued in `pending_ops`, not applied immediately. They're applied only when the cache is likely stale (TTL expired) or context pressure forces it (threshold reached).

2. **Anchored nudges**: Nudge text is appended to a specific assistant message and **stays on that same message** across turns. Moving the nudge to a different message would change the prefix. The anchor is persisted in `session_meta` so it survives restarts.

3. **Stable compartment block**: The `<session-history>` block (compartments + facts + notes + memories) is prepended as a synthetic message. It only changes when the historian produces new output. Between historian runs, the block is byte-identical across turns.

4. **Deferred memory writes**: When the agent writes a memory via `ctx_memory`, the write goes to the database immediately (for persistence), but the injected memory block in `<session-history>` doesn't update until the next historian run. This prevents mid-session cache busting from memory writes.

5. **System prompt hash tracking**: The system prompt hash is computed in `experimental.chat.system.transform`. If it changes, the cache is already busted (by the system prompt change itself), so we trigger a flush to apply all queued operations — since there's nothing left to preserve.

6. **Variant change flush**: When the session variant changes (different model), the cache prefix changes. Same logic: flush everything since the cache is already invalidated.

---

## Tagging

Every message, tool output, and file attachment receives a monotonically increasing `§N§` tag via the `Tagger`. Tags are:

- **Persisted** in the `tags` table with session ID, message ID, tag number, byte size, type, and status
- **Resumed** across restarts (counter is loaded from DB)
- **Inserted inline** into message text so the agent can reference them in `ctx_reduce` calls

The `tagMessages()` function in `transform-operations.ts`:
1. Walks all messages sequentially
2. Assigns new tags to untagged content
3. Builds a `targets` map: tag number → `{ setContent }` mutator for applying drops
4. Builds a `reasoningByMessage` map for thinking-block cleanup
5. Builds a `messageTagNumbers` map for age-based heuristics
6. Detects whether any recent message (last 10) contains a `ctx_reduce` tool call (`hasRecentReduceCall`)
7. Returns a `batch` object for deferred DB writes

Tags have three statuses:
- `active` — content is live in the conversation
- `dropped` — content has been replaced with `[dropped §N§]`
- `flushed` — drop was applied via `/ctx-flush` (applied immediately, not queued)

---

## Scheduler: Execute vs Defer

The scheduler (`scheduler.ts`) makes one binary decision per turn: should queued operations be **executed** or **deferred**?

```
execute if:
  context usage >= execute_threshold_percentage (default 65%)
  OR
  time since last response > cache_ttl (default 5m)

defer otherwise
```

The cache TTL is parsed from the `cache_ttl` config, which supports string (`"5m"`) or per-model maps (`{ "default": "5m", "anthropic/claude-opus-4-6": "60m" }`). TTL is stored per-session in `session_meta.cacheTtl` and set on session creation based on the model.

The execute threshold also supports per-model maps via `execute_threshold_percentage`.

---

## Pending Operations

When the agent calls `ctx_reduce(drop="3-5,12")`, the tool handler parses the tag references and inserts rows into the `pending_ops` table:

```sql
INSERT INTO pending_ops (session_id, tag_id, operation, status)
VALUES (?, 3, 'drop', 'pending'), (?, 4, 'drop', 'pending'), ...
```

These stay pending until the scheduler says "execute" or `/ctx-flush` forces it.

`applyPendingOperations()` walks the pending ops, finds the matching target in the `targets` map, calls `setContent("[dropped §N§]")`, and marks the op as executed. Protected tags (last N active tags) are skipped — their ops stay pending until they age out of the protected window.

After all pending ops are applied, if the queue is now empty, any persisted sticky turn reminder is also cleared.

---

## Heuristic Cleanup

Heuristic cleanup (`applyHeuristicCleanup()`) runs additional automated reductions beyond explicit agent drops. It fires **only when all conditions are met**:

```
shouldRunHeuristics =
  fullFeatureMode (not subagent)
  AND NOT compartmentRunning (historian is active)
  AND one of:
    - explicit flush (/ctx-flush)
    - force materialization (usage >= 85%)
    - pending ops being executed AND not already ran this turn
```

The "already ran this turn" check uses `lastHeuristicsTurnId` — a map of `sessionId → lastUserMessageId` — to ensure cleanup runs **at most once per user turn**. This prevents cascading cleanup from multiple transform invocations within the same turn.

When heuristics run, they:
1. **Drop old tool outputs** — tools older than `autoDropToolAge` tags (default 100)
2. **Deduplicate tool outputs** — identical tool results get earlier copies dropped
3. **Drop injections** — old system-injected content
4. **Truncate errored tools** — tool results with errors get trimmed above the watermark
5. **Strip processed images** — image parts above the watermark
6. **Clear old reasoning** — thinking/reasoning blocks older than `clearReasoningAge` tags (default 50)
7. **Strip inline thinking** — `<thinking>` XML blocks in text parts above the reasoning age
8. **Drop stale `ctx_reduce` calls** — after mutations, old reduce call/result pairs are removed

On force materialization (85%+), `dropAllTools` is set to true — all unprotected tool outputs are dropped regardless of age.

---

## Compartment Injection

Compartments are the historian's output — structured summaries that replace raw conversation history. The injection has two phases:

### Preparation (`prepareCompartmentInjection`)

Runs early in the transform (Phase 1, step 4). Reads from DB:
- All compartments for the session (ordered by startMessage)
- All session facts (categorized)
- All session notes
- All project memories (if memory is enabled)

Finds the **cutoff index** — the message array index where the last compartment's `endMessageId` falls. All messages up to this index will be replaced by the synthetic compartment block.

Returns a `PreparedCompartmentInjection` with the block text, cutoff index, and metadata. Does NOT mutate messages yet.

### Rendering (`renderCompartmentInjection`)

Runs in Phase 2, step 19, **after** all mutations are applied. This ordering is critical:

1. Pending ops and heuristic cleanup may drop messages in the covered range
2. The compartment block replaces those messages anyway
3. But the `[dropped §N§]` markers from step 13 need to exist when cleanup checks them

The renderer:
1. Finds the cutoff index in the current message array
2. Checks if `messages[0]` at the cutoff is a dropped placeholder — if so, it needs a synthetic carrier
3. Creates a synthetic message with the `<session-history>` block
4. Splices: removes messages `[0, cutoffIndex)` and prepends the synthetic message

The block structure:

```xml
<session-history>
<project-memory>
<ARCHITECTURE_DECISIONS>
- Decision 1
- Decision 2
</ARCHITECTURE_DECISIONS>
<USER_PREFERENCES>
- Preference 1
</USER_PREFERENCES>
</project-memory>

<compartment title="Early setup and configuration">
<fact>Set up the initial project structure.</fact>
<fact>Configured TypeScript strict mode.</fact>
</compartment>

<compartment title="Authentication implementation">
<fact>Added JWT-based auth with refresh tokens.</fact>
</compartment>

SESSION_NOTES:
- Always run tests before committing
</session-history>
```

---

## Memory Injection

Cross-session memories are included in the `<session-history>` block as a `<project-memory>` section. The injection is **cache-deferred**:

1. When `prepareCompartmentInjection` runs, it queries `getMemoriesByProject(db, projectPath, ["active", "permanent"])` for the current project
2. The rendered memory block is stored in `session_meta.memoryBlockCache`
3. On subsequent turns, the cached block is reused without re-querying
4. After a historian run (`replaceAllCompartmentState`), the cache is invalidated, forcing a fresh fetch on the next turn
5. When the agent calls `ctx_memory(action="write")`, the write goes to the DB immediately, but the cached block is NOT invalidated — the new memory won't appear in context until the next historian run

This ensures that background memory changes (historian promotion, dreamer consolidation) never bust the cache mid-session. Explicit `ctx_memory` writes are persisted for future sessions but don't change the current session's injected block.

---

## Dropped Placeholder Stripping

After compartment injection renders, a final pass strips messages that consist entirely of `[dropped §N§]` placeholder text. These shells served no purpose since the recall table was removed — they just waste tokens.

The stripping runs AFTER compartment injection because `renderCompartmentInjection` needs to see whether `messages[0]` is a dropped placeholder to decide if it should create a synthetic carrier message. If we stripped first, the renderer couldn't make that check.

---

## Sticky Turn Reminders

When the agent completes a tool-heavy turn (5+ tool calls without `ctx_reduce`), the `chat.message` hook persists a sticky reminder in the DB:

```
<instruction name="ctx_reduce_turn_cleanup">
Also drop via `ctx_reduce` things you don't need anymore from the last turn before continuing.
</instruction>
```

On the next transform, this reminder is appended to the latest user message — unless `hasRecentReduceCall` is true (the agent already called `ctx_reduce` in its last 10 messages), in which case the reminder is cleared without injection.

The reminder is "sticky" — it persists in the DB until either:
- The agent calls `ctx_reduce` (detected via `hasRecentReduceCall`)
- All pending ops are applied (queue becomes empty)

This ensures the reminder survives across restarts and isn't lost if the transform runs before the DB write completes.

---

## Nudging

Nudging tells the agent to reduce context. There are three nudge types:

### Rolling nudges

Computed by the nudger (`nudger.ts`) on every transform. Rolling nudges use **bands** based on context usage relative to the execute threshold:

| Band | Range | Interval multiplier |
|------|-------|---------------------|
| `far` | 0–50% of threshold | 1.5× base interval |
| `near` | 50–75% of threshold | 1× base interval |
| `urgent` | 75–100% of threshold | 0.5× base interval |
| `critical` | above threshold | 0.25× base interval |

A nudge fires when either:
- **Interval reached**: token growth since last nudge exceeds the band's interval
- **Band escalated**: usage moved into a higher-priority band since the last nudge

Nudges are suppressed when `ctx_reduce` ran recently (within 2 minutes, tracked via `recentReduceBySession`).

### Iteration nudges

When the agent has been running 15+ consecutive messages without user input and context is above 35%, an iteration nudge fires. This catches long autonomous loops where the agent forgets to clean up.

### Emergency nudge (80%+)

Fires once per session via the event handler (not the transform). See [Emergency Nudge](#emergency-nudge) below.

All nudges are wrapped in `<instruction name="context_...">` XML blocks with specific guidance, largest tags, old tool suggestions, and protected-tag warnings.

---

## Nudge Anchor Stability

Nudge text is appended to an assistant message's text part. To avoid cache busting, the nudge is **anchored** to a specific message:

1. First nudge: find the last suitable assistant message (no tool parts, not dropped), append nudge text, store `(messageId, nudgeText)` in the placement store
2. Subsequent turns: **re-inject at the same anchor message**, even if the nudge text changed. The placement store is persisted in `session_meta` so anchors survive restarts.
3. If the nudge text changes (e.g., band escalation), the old text is stripped and new text appended at the same anchor position. The log notes "keeping anchored nudge stable to avoid cache bust."
4. If the anchor message is deleted/compacted: clear the placement, the next nudge will find a new anchor.

The anchor is cleared (allowing re-placement) when:
- Flushed statuses mutate content
- Pending operations mutate content
- Mode is reduced (subagent)

This means after any content mutation, the nudge anchor is freed because the cache is already busted by the mutation itself.

---

## Emergency Nudge

The emergency nudge fires from the **event handler** (not the transform) when context usage hits 80%. It uses `promptAsync` to inject a user-role ignored message directly into the session:

```
CONTEXT EMERGENCY — ~82%. STOP all current work immediately.
You MUST use `ctx_reduce` RIGHT NOW to free space.
```

The emergency nudge:
- Fires at most once per session (tracked via `emergencyNudgeFired` set)
- Resets if usage drops below 80%
- Skips subagent sessions
- Uses the live model and variant from `liveModelBySession` / `variantBySession`
- Falls back gracefully if `promptAsync` is unavailable

---

## System Prompt Hash Detection

The `experimental.chat.system.transform` hook (`system-prompt-hash.ts`) runs on every turn with access to the assembled system prompt. It does two things:

### 1. Inject agent guidance

If the system prompt doesn't already contain `## Magic Context`, the handler:
1. Detects the known agent (Sisyphus, Atlas, Oracle, Athena, generic) from prompt content
2. Builds tailored reduction guidance with per-agent instructions
3. Appends it to `output.system`

This means agent prompts don't need to bake in magic-context instructions — the plugin injects them at runtime.

### 2. Detect system prompt changes

Computes `Bun.hash(systemContent)` and compares against the stored hash in `session_meta.systemPromptHash`:
- Hash changed → the Anthropic cache prefix is already busted → trigger flush (`flushedSessions.add`) and clear heuristic turn tracking
- Hash is 0 (first turn) → initialize, no flush
- Hash unchanged → no action

The flush is the same as `/ctx-flush`: all pending ops will execute on the next transform pass.

---

## Variant Change Flush

When the user switches models mid-session, the `chat.message` hook detects the variant change:

```typescript
if (previousVariant !== undefined && input.variant !== undefined && previousVariant !== input.variant) {
    flushedSessions.add(sessionId);
    lastHeuristicsTurnId.delete(sessionId);
}
```

Both the old and new variant must be defined (non-undefined) to trigger a flush. This prevents false flushes from system notifications that lack variant information.

---

## Compartment Trigger Heuristics

The compartment trigger (`compartment-trigger.ts`) decides when to start a historian run. It's checked in the event handler (on `message.updated` events) using fresh context usage data.

Four trigger paths, checked in order:

### 1. Force at 80%

If context usage ≥ 80%, fire unconditionally — unless pending drops alone would bring usage below `executeThreshold × 0.75`. This prevents starting a historian run when simple drops would suffice.

### 2. Commit clusters

If the unsummarized tail contains 2+ distinct commit clusters AND the tail's token estimate exceeds the compartment token budget, fire. Commit clusters represent distinct work phases — the historian produces better summaries when it has complete work units.

### 3. Tail size

If the unsummarized tail exceeds 3× the compartment token budget regardless of pressure or commits, fire. This catches long sessions with lots of conversation but no commits.

### 4. Projected headroom

If context usage is near the execute threshold (within 2%) and projected post-drop usage still exceeds `executeThreshold × 0.75` and the unsummarized tail is meaningful (≥6000 tokens or ≥12 messages), fire.

The trigger skips entirely if:
- A compartment run is already in progress
- There's no new raw history since the last compartment

---

## Historian Lifecycle

When a trigger fires, `session_meta.compartmentInProgress` is set to true. The transform's compartment phase:

1. Checks if `compartmentInProgress` is true and no active run exists
2. Reads an eligible chunk of raw history (up to `compartmentTokenBudget` tokens)
3. Starts the historian as a child agent session
4. If usage ≥ 95% (`BLOCK_UNTIL_DONE_PERCENTAGE`), blocks and awaits the result
5. Otherwise, the historian runs in the background

When the historian finishes:
1. Its XML output is parsed into compartments, facts, and notes
2. `replaceAllCompartmentState()` atomically replaces all compartment data in the DB
3. Qualifying facts are promoted to the cross-session memory store
4. `compartmentInProgress` is cleared
5. Memory block cache is invalidated (new memories from promotion)
6. A progress notification is sent to the session

On the next transform, `prepareCompartmentInjection` reads the new compartments and re-renders the `<session-history>` block.

---

## Reduced Mode (Subagent Sessions)

Background tasks, subagent sessions, and child sessions run in **reduced mode**. The transform still:
- Tags messages
- Applies flushed statuses
- Strips structural noise and cleared reasoning

But skips:
- Compartment injection and preparation
- Compartment trigger checks
- Nudge computation
- Heuristic cleanup
- Sticky turn reminders

This prevents subagent sessions from triggering historian runs or accumulating state that interferes with the parent session.

Reduced mode is determined by `sessionMeta.isSubagent`, which is set on `session.created` events when the session has a `parentID`.

---

## Tool Execute After Hook

The `tool.execute.after` hook fires after every tool execution:

```typescript
if (tool === "ctx_reduce") {
    recentReduceBySession.set(sessionId, Date.now());
}
toolUsageSinceUserTurn.set(sessionId, turnUsage + 1);
```

This feeds two systems:
1. **Nudge suppression**: `recentReduceBySession` timestamps are checked by the nudger to suppress nudges within 2 minutes of a `ctx_reduce` call
2. **Sticky turn reminders**: `toolUsageSinceUserTurn` counts are checked by the `chat.message` hook to decide whether to persist a cleanup reminder

---

## Event Handler

The event handler (`event-handler.ts`) processes OpenCode lifecycle events:

### `session.created`
- Sets `isSubagent` flag if the session has a parent
- Resolves and stores cache TTL for the session's model

### `message.updated`
- Extracts usage tokens (input + cache read + cache write)
- Computes context usage percentage against the model's context limit
- Updates `contextUsageMap` (in-memory) and `session_meta` (DB)
- Checks compartment trigger heuristics
- Fires if a trigger condition is met

### `session.compacted`
- Delegates to `compactionHandler` (handles OpenCode's built-in compaction events)
- Invalidates session cache

### `session.deleted`
- Cleans up all in-memory maps
- Clears session data from DB
- Invalidates session cache

---

## In-Memory State Maps

These maps live in the hook closure (not persisted across restarts unless noted):

| Map | Key | Value | Purpose |
|-----|-----|-------|---------|
| `contextUsageMap` | sessionId | `{ usage, updatedAt }` | Latest context usage from events |
| `liveModelBySession` | sessionId | `{ providerID, modelID }` | Current model for notifications |
| `variantBySession` | sessionId | variant string | Variant change detection |
| `recentReduceBySession` | sessionId | timestamp | Nudge suppression window |
| `toolUsageSinceUserTurn` | sessionId | count | Sticky turn reminder threshold |
| `emergencyNudgeFired` | sessionId | (set membership) | One-shot emergency nudge |
| `flushedSessions` | sessionId | (set membership) | Pending explicit flush |
| `lastHeuristicsTurnId` | sessionId | user message ID | Once-per-turn heuristic guard |

The nudge placement store is hybrid: in-memory with DB persistence. It reads from memory first, falls back to DB on miss, and writes to both.

---

## Ordering Constraints

The transform's step ordering is not arbitrary. Key dependencies:

1. **Tagging before everything** — all subsequent steps reference tags
2. **Flushed statuses before pending ops** — pre-flushed drops must be visible before the scheduler decides
3. **Structural noise stripping before cleanup** — empty parts can confuse age-based heuristics
4. **Scheduler decision before pending ops** — the scheduler gates whether ops execute
5. **Compartment phase before rendering** — may start a historian run that changes the injection
6. **Pending ops before heuristic cleanup** — cleanup runs after user-requested drops
7. **Heuristic cleanup before reasoning cleanup** — tool dropping affects which reasoning blocks are stale
8. **Batch finalize after all mutations** — DB writes happen in one transaction
9. **Stale reduce call dropping after mutations** — needs to see which drops actually applied
10. **Compartment rendering after all mutations** — the splice replaces messages that may have been modified
11. **Dropped placeholder stripping after compartment rendering** — renderer checks if messages[0] is a placeholder
12. **Sticky reminder after stripping** — needs to find the actual latest user message
13. **Nudge computation last** — needs final context state after all mutations
14. **Nudge application last** — appends to a message that shouldn't change again

Breaking any of these ordering constraints can cause:
- Silent data loss (drops applied to wrong content)
- Cache busting (mutations after injection change the prefix)
- Stale state (heuristics run on pre-mutation data)
- Infinite loops (sticky reminders on removed messages)
