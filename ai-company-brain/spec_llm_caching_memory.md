# LLM Prompt Caching + Memory System — Development Plan

> **Status:** Planned — not yet implemented
> **Owner:** CommandCenter Core
> **Created:** 2026-06-17
> **ADR references:** ADR-008 (approved, unimplemented), ADR-012 (Phase 2 deferred)
> **WBS reference:** WBS 2.6 (semantic cache + token compression)
> **Related files:** `packages/acb_llm/acb_llm/client.py`, `apps/orchestrator/orchestrator/executor.py`, `packages/acb_memory/`, `infra/litellm/config.yaml`, `apps/gateway/gateway/routes/agent.py`

---

## Why This Matters

Every agent request processes the full system prompt from scratch. For a typical CommandCenter agent call:

- **System prefix** (agent instructions + tool addendum): ~3,000–4,000 tokens — static, identical across all turns
- **Memory context** (Mem0 + Graphiti): ~200–600 tokens — dynamic per user/query
- **Conversation history**: grows per turn

At current usage with Claude Sonnet 4.6 ($3/MTok input):
- Each 3,500-token system prefix costs **$0.0105** per request
- With Anthropic prompt caching, cache reads cost **$0.0003** (10% of base)
- **Saving: ~$0.0102 per cached request (~97% reduction on the stable prefix)**

Beyond cost, cache hits also reduce time-to-first-token by 30–80% for long system prompts.

---

## Current State Audit

### What Exists

| Component | Current Status | Cache-Friendly? |
|---|---|---|
| `_build_injected_tools_addendum()` in `executor.py` | LRU-cached (module-level), byte-stable | ✅ Content is stable |
| `_build_registry_block()` in `executor.py` | LRU-cached, only changes on gateway restart | ✅ Content is stable |
| Agent instructions from repo | Loaded once per clone, never changes mid-run | ✅ Content is stable |
| Memory context from Mem0 | Fetched fresh every request via semantic search | ❌ Changes per user + query |
| Memory context from Graphiti | Fetched fresh every request, time-stamped | ❌ Changes as new facts arrive |
| System prompt final assembly | Flat string concat — not structured blocks | ❌ Providers can't identify stable boundary |
| `acb_llm/client.py` `acompletion()` calls | No `cache_control` params, no `prompt_cache_key` | ❌ No explicit caching |
| LiteLLM proxy (infra) | No Redis cache configured | ❌ No proxy-level caching |
| Token tracking (gateway + workbench) | No `cache_read_input_tokens` / `cache_creation_input_tokens` | ❌ No cache visibility |

### What Already Works Accidentally

OpenAI and Anthropic do implicit server-side caching when the same byte-identical prefix is sent repeatedly. Because the stable prefix (instructions + tool addendum) is always assembled first and the LRU cache makes it byte-stable, **implicit KV-cache hits may already occur** for same-agent same-user consecutive turns within ~5 minutes. However:

- We have no telemetry to confirm this
- Any change in memory context (different query → different Mem0 results) changes the concatenated system string, making the prefix hash differ even if the stable part is identical
- We're not explicitly marking breakpoints, so Anthropic's 5-min TTL cache lifecycle is not guaranteed

---

## Architecture: How Provider Caching Works

### Anthropic

- Requires **explicit `cache_control: {"type": "ephemeral"}`** on content blocks in the `system` array
- System prompt must be a **list of content blocks**, not a flat string
- Minimum cacheable prefix: **1,024 tokens** (Sonnet 4.6, Haiku 4.5); 4,096 for some Opus models
- Cache prefix order: `tools` → `system` → `messages`
- Default TTL: 5 minutes (refreshed on each hit); 1-hour TTL available at 2× write cost
- Write cost: 1.25× base input token price; Read cost: 0.10× base input token price
- Up to 4 explicit breakpoints per request; automatic caching also available (top-level `cache_control` field)
- Cache is workspace-isolated (as of Feb 2026)

### OpenAI

- Caching is **automatic** for prompts ≥ 1,024 tokens — no code changes required
- Cache hit reflected in `usage.prompt_tokens_details.cached_tokens`
- Add `prompt_cache_key` to route requests for the same prefix to the same server → improves hit rate
- Default in-memory TTL: 5–10 min (up to 1 hour off-peak); extended 24h available for newer models
- Static content must be at the **beginning** of the prompt

### Key Rule (Both Providers)

> Place static content first. Place dynamic content (memory, history, user message) last. Mark the boundary explicitly where possible.

---

## Implementation Plan

### Phase 1 — Observability (Week 1, ~3 hours)

**Goal:** Measure current cache state before changing anything.

**1.1 — Cache token logging in `acb_llm/client.py`**

After every `acompletion()` call in both `complete()` and `complete_with_tools()`, extract and log cache usage from the provider response:

```python
usage = response.get("usage") or {}
cache_read = (
    usage.get("cache_read_input_tokens")                              # Anthropic
    or (usage.get("prompt_tokens_details") or {}).get("cached_tokens")  # OpenAI
    or 0
)
cache_write = usage.get("cache_creation_input_tokens", 0)  # Anthropic only

_log.info("llm.completion",
          model=model,
          input_tokens=usage.get("input_tokens") or usage.get("prompt_tokens", 0),
          output_tokens=usage.get("output_tokens") or usage.get("completion_tokens", 0),
          cache_read_tokens=cache_read,
          cache_write_tokens=cache_write)
```

**1.2 — Pass cache stats through audit layer**

Extend `AuditEvent` (or the existing audit log payload in `acb_audit`) to include `cache_read_tokens` and `cache_write_tokens` as optional integer fields. The gateway's audit recording in the agent run path should pass these through.

**1.3 — Workbench cache badge (optional, defer to Phase 4)**

A small "Cache" pill in the chat response header showing `X tokens from cache`. Requires a new SSE event type or extension of the existing `STEP_FINISHED` event payload from the gateway → Next.js route → chat UI.

---

### Phase 2 — OpenAI Automatic Cache + Routing Key (Week 1, ~1 hour)

**Goal:** Maximise OpenAI cache hit rate with zero structural change.

OpenAI caching is already automatic. The only enhancement is adding `prompt_cache_key` so that all requests for the same agent are routed to the same server pool.

**2.1 — Add `cache_key` parameter to `acb_llm/client.py`**

```python
async def complete(*, tier, messages, ..., cache_key: str | None = None, **extra) -> str:
    if cache_key:
        extra["prompt_cache_key"] = cache_key
    response = await acompletion(model=model, messages=messages, ..., **extra)
```

Same change for `complete_with_tools()`.

**2.2 — Pass agent name as `cache_key` from call sites**

In `executor.py`, when the orchestrator calls `complete()` or `complete_with_tools()` for triage / extraction tasks, pass `cache_key=agent_name`.

For the mutation layer in `mutation.py`, pass `cache_key="mutation"`.

---

### Phase 3 — Anthropic Explicit Cache Breakpoints (Week 2, ~4 hours)

**Goal:** Explicit 10× cost reduction on the stable system prefix for all Anthropic model calls.

This is the highest-value change. The problem is that MAF's `GitHubCopilotAgent` and the LiteLLM proxy both receive the system prompt as a flat string — not the structured block list Anthropic requires. The correct fix is a **LiteLLM pre-call hook** that transforms the prompt transparently, so that all execution paths (MAF agent, direct `acb_llm` calls, orchestrator) benefit without touching MAF internals.

**3.1 — Sentinel marker in `executor.py`**

At the stable/dynamic boundary during system prompt assembly (~line 1750), change:
```python
_merged = f"{_existing}\n\n{_memory_context}"
```
to:
```python
_merged = f"{_existing}\n<!-- CACHE BREAK -->\n{_memory_context}"
```

This single-line change marks where the stable prefix ends. The sentinel is invisible to the LLM — it is consumed by the LiteLLM hook before the request leaves the gateway.

**3.2 — LiteLLM pre-call hook `acb_litellm_hooks.py`**

Create `infra/litellm/acb_litellm_hooks.py` (mounted into the LiteLLM container):

```python
def pre_call_hook(data: dict, ...) -> dict:
    """
    For Anthropic requests: if system contains '<!-- CACHE BREAK -->',
    split into two content blocks and add cache_control on the stable block.
    """
    model = data.get("model", "")
    if "anthropic" not in model and "claude" not in model:
        return data

    system = data.get("system")
    if not isinstance(system, str) or "<!-- CACHE BREAK -->" not in system:
        return data

    parts = system.split("<!-- CACHE BREAK -->", 1)
    stable_part = parts[0].rstrip()
    dynamic_part = parts[1].lstrip() if len(parts) > 1 else ""

    blocks = [{"type": "text", "text": stable_part,
               "cache_control": {"type": "ephemeral"}}]
    if dynamic_part:
        blocks.append({"type": "text", "text": dynamic_part})

    data["system"] = blocks
    return data
```

Register in `infra/litellm/config.yaml`:
```yaml
litellm_settings:
  callbacks: ["acb_litellm_hooks.pre_call_hook"]
```

**Important constraints:**
- The stable prefix must be ≥ 1,024 tokens. At ~3,500 tokens, this is well above the minimum for all current models.
- The sentinel must not appear in user-facing output. The hook consumes it before it reaches the model.
- Thinking blocks cannot be directly marked with `cache_control` — this hook only touches the `system` field, so thinking is unaffected.

**3.3 — Tool definitions caching**

Anthropic caches in the order: `tools` → `system` → `messages`. If tool definitions are large and stable, add `cache_control` on the last tool definition block. For CommandCenter-injected tools (call_agent, web_search, etc.), these are already stable and described in the system prompt addendum — no separate tool-level caching needed unless tool schemas are added separately in the future.

---

### Phase 4 — Session-Scoped Memory (Week 3, ~3 hours)

**Goal:** Make memory byte-stable within a session so the stable prefix + memory block together become cache-eligible across turns.

**The problem:** Mem0 uses semantic search — different queries against the same user's memory return different result sets. This means even if the stable prefix is cached, the combined `[stable prefix + memory]` block changes every turn → no cross-turn cache reuse on the memory portion.

**The solution:** Cache memory per session in Redis, fetched once at session start and reused for all turns in that session.

**4.1 — Session memory cache in gateway agent route**

In `apps/gateway/gateway/routes/agent.py`, before calling `get_memory_context()`:

```python
_mem_key = f"session_mem:{thread_id}"
_cached = await redis.get(_mem_key)
if _cached:
    memory_context = _cached.decode()
else:
    memory_context = await get_memory_context(user_id, message)
    if memory_context:
        await redis.setex(_mem_key, 600, memory_context)  # 10-minute session TTL
```

Apply the same pattern in `apps/gateway/gateway/main.py` for the orchestrator `/copilot/chat` path (`enrich_instructions_with_memory()`).

**Tradeoff:** Memory does not update mid-session. This is acceptable because:
- Agents can call `recall_timeline(entity, query)` explicitly for fresh data when needed
- `add_memories_background()` runs async anyway; new facts are available in the next session
- A 10-minute TTL matches the LLM provider cache TTL, so the two systems expire together

**4.2 — Graphiti episode write filter (Week 3, ~2 hours)**

Currently every conversation turn triggers `add_episode()` in Graphiti, which bloats the knowledge graph with low-signal entries (greetings, status checks, confirmations) and degrades retrieval quality. This indirectly hurts memory stability: more noise → different semantic search results → different memory blocks → cache misses.

Add a quick LLM-based filter (tier1, ~50 tokens) before writing a Graphiti episode:

```python
async def _is_episode_worthy(messages: list[dict]) -> bool:
    """Return True if the exchange contains a named entity, date, commitment,
    or decision worth recording in the knowledge graph."""
    ...
```

Only call `add_episode()` when `_is_episode_worthy()` returns True. This is a semantic quality gate, not a performance gate.

---

### Phase 5 — LiteLLM Proxy Redis Cache (Week 1, ~1 hour)

**Goal:** Exact-match prompt cache at the proxy layer — free wins for repeated identical calls (classification, triage, structured extraction).

Enable LiteLLM's built-in Redis cache in `infra/litellm/config.yaml`:

```yaml
litellm_settings:
  cache: True
  cache_params:
    type: redis
    host: redis          # existing Redis service in docker-compose.yml
    port: 6379
    ttl: 300             # 5 minutes — matches provider cache TTL
    mode: default_off    # opt-in per request only
```

Use `mode: default_off` so only explicitly opted-in calls are cached. Opt-in from `acb_llm/client.py`:

```python
async def complete(*, tier, messages, ..., enable_litellm_cache: bool = False, **extra):
    if enable_litellm_cache:
        extra["cache"] = {"no-cache": False, "no-store": False}
```

Good candidates for opt-in caching:
- Mutation layer prompt analysis (same error → same fix analysis)
- Triage / classification calls with identical or near-identical inputs
- Structured extraction on repeated webhook payloads

---

### Phase 6 — Cache Warming at Startup (Week 4, ~2 hours)

**Goal:** Eliminate the first-request cache-miss latency penalty for high-frequency agents.

Anthropic's `max_tokens: 0` API feature (available since Feb 2026) lets you write to the cache without generating output or paying for completions.

In `apps/gateway/gateway/main.py` startup event:

```python
@app.on_event("startup")
async def _prewarm_anthropic_cache():
    """Pre-warm the Anthropic KV cache for high-frequency agents at startup."""
    from orchestrator.executor import _build_injected_tools_addendum, _PULL_INSTRUCTIONS
    stable_prefix = _PULL_INSTRUCTIONS + _build_injected_tools_addendum()

    for model in ["claude-sonnet-4-6", "claude-haiku-4-5"]:
        try:
            await _anthropic_prewarm(stable_prefix, model=model)
            _log.info("cache.prewarm_complete", model=model)
        except Exception as exc:
            _log.warning("cache.prewarm_failed", model=model, error=str(exc))
```

The pre-warm fires `max_tokens=0` with the system prompt marked `cache_control: {"type": "ephemeral"}`. No response is generated; only the cache write is charged (1.25× for the first write, then reads are 0.10×).

For the 5-minute default TTL: schedule a background task to re-warm every 4 minutes.  
For agents that run less frequently than every 5 minutes: use `ttl: "1h"` (2× write cost) to avoid the warmup loop overhead.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Sentinel marker leaking into LLM context | Medium | LiteLLM hook consumes it before the request leaves; add an assertion in hook tests |
| Anthropic cache miss due to < 1,024 token prefix | Low | Current prefix is ~3,500 tokens; add a token count assertion in tests |
| Session memory stale mid-session | Low | Agents can call `recall_timeline()` explicitly; 10-min TTL is short enough for most sessions |
| LiteLLM hook breaks non-Anthropic calls | Low | Hook is gated on `"anthropic" in model or "claude" in model` |
| MAF internal format conflicts with structured system blocks | Medium | Option A (LiteLLM hook) avoids touching MAF at all; MAF sees a pre-transformed request |
| Graphiti episode filter false negatives | Low | Filter is conservative (passes anything uncertain); worst case is current behaviour |
| Pre-warm loop adds startup latency | Low | Pre-warm is fire-and-forget (`asyncio.create_task`); startup does not block |
| Cache workspace isolation (Anthropic Feb 2026 change) | None | CommandCenter uses a single API workspace — all agents share a pool, which is the desired behaviour |

---

## Expected Impact

| Change | Tokens Saved Per Request | Cost Change |
|---|---|---|
| Anthropic explicit cache (stable prefix ~3,500 tokens) | 3,500 tokens @ 10% on hit | **~90% reduction on system prefix** |
| OpenAI `prompt_cache_key` routing | Higher hit rate on implicit cache | ~15–20% more cache hits |
| Session memory (10-turn session) | 9/10 turns reuse same memory block | Memory portion also cache-eligible cross-turn |
| Graphiti episode filter | Fewer writes → cleaner retrieval → stable memory | Indirect quality + retrieval cost reduction |
| LiteLLM proxy cache | 100% saving on exact-match repeated calls | Variable; useful for classification/triage paths |
| Cache warming | Eliminates cold-start penalty on first user request | Latency: −30–80% on first request TTFT |

**Rough monthly estimate** for 10,000 agent requests/month, 3,500-token stable prefix, Claude Sonnet 4.6:
- Without caching: 10,000 × 3,500 tokens × $3/MTok = **$105/month** on stable prefix alone
- With caching (80% hit rate): $105 × 0.2 (misses at 1.25× write) + $105 × 0.8 × 0.1 (hits at 0.1×) = **$29.40/month**
- **Saving: ~$75/month (~72%)** — purely on the stable system prefix

---

## Execution Order

```
Week 1, Day 1   Phase 1.1   Cache token logging in acb_llm/client.py         ~1h
Week 1, Day 1   Phase 5     LiteLLM Redis cache config (infra/litellm)         ~1h
Week 1, Day 2   Phase 1.2   Audit layer cache stats propagation                ~1h
Week 1, Day 3   Phase 2     OpenAI prompt_cache_key in acb_llm + executor      ~1h
Week 2, Day 1   Phase 3.1   Sentinel marker in executor.py memory injection    ~30m
Week 2, Day 1   Phase 3.2   LiteLLM pre-call hook + config registration        ~3h
Week 2, Day 2   Phase 3.3   Verify token count >= 1,024 in tests               ~30m
Week 3, Day 1   Phase 4.1   Session-scoped memory in Redis (agent route)       ~2h
Week 3, Day 2   Phase 4.1   Same change for orchestrator /copilot/chat path    ~1h
Week 3, Day 3   Phase 4.2   Graphiti episode worthiness filter                 ~2h
Week 4, Day 1   Phase 6     Cache warming at startup (gateway main.py)         ~2h
Week 4, Day 2   Phase 1.3   Workbench cache stats badge (optional)             ~3h
```

Total implementation effort: **~18 hours** across 4 weeks.

---

## File Inventory

Files to create:

| File | Purpose |
|---|---|
| `infra/litellm/acb_litellm_hooks.py` | LiteLLM pre-call hook — sentinel → structured blocks |

Files to modify:

| File | Change |
|---|---|
| `packages/acb_llm/acb_llm/client.py` | Log cache tokens; add `cache_key` and `enable_litellm_cache` params |
| `apps/orchestrator/orchestrator/executor.py` | Insert `<!-- CACHE BREAK -->` sentinel at memory injection boundary |
| `infra/litellm/config.yaml` | Enable Redis cache; register hook callback |
| `apps/gateway/gateway/routes/agent.py` | Session-scoped memory cache in Redis |
| `apps/gateway/gateway/main.py` | Session-scoped memory cache for `/copilot/chat` path; startup cache warming |
| `packages/acb_memory/acb_memory/graphiti_client.py` | Episode worthiness filter |
| `packages/acb_audit/` | Add `cache_read_tokens` / `cache_write_tokens` fields to AuditEvent |

No new infrastructure required — Redis already exists in `infra/docker-compose.yml`.

---

## Testing Plan

For each phase:

1. **Phase 1 (Observability):** After deploying, run 5 consecutive requests against the same agent. Confirm `llm.completion` log lines appear with `cache_read_tokens > 0` on requests 2–5.

2. **Phase 2 (OpenAI routing key):** Use the workbench model picker to select an OpenAI model. Send 3 identical messages. Confirm `usage.prompt_tokens_details.cached_tokens` grows across turns in the gateway logs.

3. **Phase 3 (Anthropic explicit cache):** With `ANTHROPIC_API_KEY` configured, run 2 requests to the same agent. First request should show `cache_creation_input_tokens ≈ 3,500`. Second request should show `cache_read_input_tokens ≈ 3,500`. Verify sentinel string does not appear in any LLM response.

4. **Phase 4 (Session memory):** Run a 5-turn conversation. Confirm Redis key `session_mem:{thread_id}` is set after turn 1 and not re-fetched on turns 2–5 (check Mem0/Graphiti call count in logs).

5. **Phase 5 (LiteLLM cache):** Trigger the same classification/triage flow twice. Second call should return from Redis cache (visible in LiteLLM logs as `cache_hit: true`).

6. **Phase 6 (Warm-up):** Restart the gateway. Confirm the startup log includes `cache.prewarm_complete` for each model before the first user request arrives. Verify first request shows `cache_read_input_tokens > 0`.

---

## DOX Update Required After Implementation

When each phase is implemented:
- Update `ai-company-brain/system_architecture.md` ADR-008 status from "approved / unimplemented" to "implemented"
- Update `ai-company-brain/wbs.md` WBS 2.6 status
- Update `apps/orchestrator/AGENTS.md` to note sentinel marker convention
- Update `packages/acb_llm/AGENTS.md` (or create if absent) to document cache parameters
- Update `packages/acb_memory/` AGENTS.md to document session-scoped memory TTL contract
