# Memory Compartments & Run Clearance

**Status:** Draft / RFC · **Date:** 2026-07-26 · **Owner:** vjvarada
**Companion to:** [`README.md`](README.md) (the multiplayer room model) ·
[`agent-kinds.md`](agent-kinds.md) (personal vs shared agents) ·
[`../../ai-company-brain/specs/multi_user_organization_research.md`](../../ai-company-brain/specs/multi_user_organization_research.md) (org/RBAC)

> **Read [`agent-kinds.md`](agent-kinds.md) first.** An agent's *instancing* (one brain per
> person / per team / for everyone) decides how the `agent:` compartment below is keyed, and
> whether the agent's sessions may become rooms at all. This doc assumes that choice is made.

How one agent holds memory across sessions **and** across people, and decides which
parts of it are usable on any given call.

Mockups: [`mockup-share.html`](mockup-share.html) (going shared mid-conversation) ·
[`mockup-memory.html`](mockup-memory.html) (what it knows, and who can see it)

---

## 1. The case that breaks the simple model

From the room RFC, `chat_session.context_policy` was `room | driver | none` — a per-room
switch for whether personal memory participates. That is too coarse to survive a real
situation:

> The CEO discusses **Project Falcon** with `agent-sales` — an acquisition nobody outside
> two people should know exists. The same CEO, with the *same agent*, also works the **Acme
> renewal**, which is deliberately collaborative: three people in a deal room, all of whom
> should share the agent's context on it.

Under a per-room switch:

- `context_policy='driver'` in the Acme room loads the CEO's personal memory — and Mem0
  retrieval is **semantic**, so a question about "the enterprise pipeline" can surface
  Falcon on similarity alone. Nobody made a mistake; the retriever did its job.
- `context_policy='room'` excludes personal memory entirely — so the agent forgets
  everything the CEO ever told it, including the Acme context that *should* be shared.

Both are wrong because the switch is on the wrong axis. **Confidentiality is not a property
of a person, and it is not a property of a room. It is a property of a subject.** Falcon is
restricted; Acme is not; both belong to the same person and the same agent.

So memory has to be partitioned by **compartment**, and each call has to run at a
**clearance**.

---

## 2. What the memory layer already gives us

This design is smaller than it sounds because the partitioning primitive already exists and
is in the right place.

| Fact | Where | Why it matters |
|---|---|---|
| One function builds every memory partition key | `scope_key(user=…, agent=…, org=…)` — `packages/acb_memory/acb_memory/mem0_client.py:50` | Adding compartment kinds is an extension of one function plus its constants, not a new store. |
| The scope rides Mem0's `user_id` field | `mem0_client.py:184-198`, `:231-239` — `client.search(query, filters={"user_id": scope})` | **The partition is applied inside the vector query.** A compartment we don't pass is never searched — not searched-then-filtered. This is the difference between a boundary and a suggestion. The module docstring (`:12-15`) says they chose `user_id` over `agent_id` precisely because it is the field Mem0 reliably filters on. |
| Three scopes already coexist in one collection | `AGENT_SCOPE_PREFIX = "agent:"`, `ORG_SCOPE_KEY = "org:global"` (`:46-47`) | The namespacing convention for new compartment kinds is established. |
| Per-scope read/write/enumerate helpers | `get_scoped_context`, `add_scoped_memories`, `get_scoped_all` (`:313-349`) | A compartment read is a call we already have; the inspector UI gets `get_scoped_all` for free. |
| Graphiti episodes are grouped | `add_episode(..., group_id=…)` — `graphiti_client.py:187` | Subject compartments map onto `group_id`, so the knowledge graph partitions the same way. |
| The assembled block is cached per thread | `get_session_memory` / `invalidate_session_memory` | Multi-compartment reads cost N searches; the existing cache absorbs that across turns (and it is why the block must stay byte-stable for prompt caching). |

### 2.1 Prerequisite: the memory API was open by path parameter — ✅ fixed 2026-07-30

`apps/services/gateway/gateway/routes/memory.py` resolves `UserContext` on every route and
then **never compares it to the `{user_id}` in the path**:

```python
@router.get("/{user_id}", summary="List all memories for a user")
async def list_memories(user_id: str, user: UserContext = Depends(get_current_user)):
    return await client.get_all(user_id)      # user is resolved, then ignored
```

Any authenticated user could list (`:59`), semantically search (`:71`), delete (`:84`), and
write (`:97`) **any** other user's memory scope by putting their email in the URL.

**It was worse than "needs a signed-in session".** Two of the three paths in did not need
one at all:

- `/api/chat/memories?userId=<colleague>` (Next BFF) took the scope from a query parameter,
  never called `auth()`, and `/api/chat/` sits in the proxy's public list.
- `lib/memory.ts` forwarded only the internal Bearer token and no identity headers, and the
  gateway reads a bearer-without-identity call as **the platform acting as itself** — full
  service access (`acb_auth/deps.py` §1b). So the scope check had nobody to compare against
  even once it existed.

The fix therefore lands in three places, and the middle one is the reason the first alone
would not have been enough:

1. `_authorize_scope` in `routes/memory.py` — one rule per scope shape (own email / agent /
   org), unknown shapes refused, and `delete` additionally confirms the memory is *in* the
   scope (naming your own scope and a colleague's memory id was the same IDOR one level
   down).
2. `lib/memory.ts` forwards the acting member, and the two Next routes require a session and
   derive the scope from it rather than from caller input.
3. A service principal may reach shared scopes but must **assert an identity** to touch a
   person's. `deps.py` §1b argues a narrower service grant is theatre since the token holder
   could assert any email anyway — true, and beside the point: the distinction that matters
   is between asserting an identity and *omitting* one, and omission is exactly how this bug
   happened.

This had to be fixed **before** compartments mean anything: a compartment model whose read
API is addressable by guessing a scope key is decorative. The shape of the fix, as built:

```python
compartment = resolve_compartment(scope_key)          # 404 if unknown
if not can_read(compartment, user):                   # membership / audience check
    raise HTTPException(403, "Not your memory")
# delete additionally requires ownership or can_promote
```

---

## 3. The model

### 3.1 Compartments

A **compartment** is the unit of memory scoping. Every fact lives in exactly one. A
compartment's identity is its scope key; its **audience** is who may read it.

```python
# scope_key() extended — same function, new kinds
scope_key(user="vijay@fracktal.in")          → "vijay@fracktal.in"        # existing
scope_key(user="vijay@fracktal.in", prefs=True)
                                             → "prefs:vijay@fracktal.in"  # NEW
scope_key(room="thread-abc123")              → "room:thread-abc123"       # NEW
scope_key(subject="deal/zoho-4471")          → "subject:deal/zoho-4471"   # NEW
scope_key(agent="sales")                     → "agent:sales"              # existing
scope_key(org=True)                          → "org:global"               # existing
```

| Kind | Holds | Default audience | Travels into a shared room? |
|---|---|---|---|
| `prefs:<email>` | **How this person works** — "prefers terse answers", "wants the number first, reasoning after" | The person, wherever they are | **Yes**, for the person currently being answered |
| `<email>` (user) | **What this person told it** — episodic facts from their private sessions | Private, always | **Never** |
| `subject:<entity>` | Everything about a deal / customer / project | Explicit member list | Only if every viewer is a member |
| `room:<thread_id>` | Facts established in this room | Room members | It *is* the room |
| `agent:<name>[#instance]` | Tradecraft the agent learns — "Odoo invoice lines lag Zoho ~2 days" | Depends on the agent's **instancing** — see [`agent-kinds.md`](agent-kinds.md) | Yes, if the viewers share the instance |
| `file:agent:<name>#<instance>` | The **always-on file tier** — curated `agent-data/` knowledge injected on every run | Same as the agent instance | Yes, if the viewers share the instance — and this is the tier to get right first (see below) |
| `org:global` | Company facts — "standard terms are Net 30" | Org | Yes |

**Splitting personal memory into `prefs` and `user` is what makes shared rooms usable.** In a
shared room nobody's `user:` compartment loads — not even the driver's — but the floor
holder's `prefs:` does. The agent still answers in your register and respects how you like to
work, without exposing a single thing you told it in private. Preferences are self-descriptive
and you are in the room; episodic facts are not and may not be.

### 3.2 The compartment registry

```sql
-- migration 118_memory_compartments.sql
CREATE TABLE IF NOT EXISTS memory_compartment (
    scope_key    TEXT PRIMARY KEY,          -- the Mem0 user_id partition value
    kind         TEXT NOT NULL CHECK (kind IN
                   ('prefs','user','subject','room','agent','org')),
    label        TEXT,                      -- "Project Falcon"
    entity_ref   TEXT,                      -- 'deal:zoho-4471' → acb_graph entity
    audience     TEXT NOT NULL DEFAULT 'private'
                   CHECK (audience IN ('private','explicit','room','team','org')),
    sensitivity  TEXT NOT NULL DEFAULT 'normal'
                   CHECK (sensitivity IN ('normal','restricted')),
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_compartment_member (
    scope_key    TEXT NOT NULL REFERENCES memory_compartment(scope_key) ON DELETE CASCADE,
    user_email   TEXT NOT NULL,
    can_promote  BOOLEAN NOT NULL DEFAULT false,   -- may widen this compartment's audience
    granted_by   TEXT,
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_key, user_email)
);
CREATE INDEX IF NOT EXISTS memory_compartment_member_user_idx
    ON memory_compartment_member (user_email);

-- A session or room may be BOUND to a subject. Binding is consent (see §4.2).
ALTER TABLE chat_session
    ADD COLUMN IF NOT EXISTS subject_ref TEXT;   -- 'deal:zoho-4471'
```

`sensitivity='restricted'` is not an extra permission — membership already governs that. It
drives *behaviour*: restricted compartments never appear in autocomplete for
non-members, never surface in a cross-compartment search, and block mid-run joins (§5.4).

### 3.3 The clearance rule

> **A run reads at the clearance of its least-cleared viewer.**

```python
def clearance(run) -> set[str]:
    viewers = room_members_who_can_see_output(run.thread_id)   # solo thread → {you}
    personal = intersection(compartments_readable_by(v) for v in viewers)
    return personal | {
        scope_key(agent=run.agent_name),
        scope_key(org=True),
        scope_key(room=run.thread_id),
        scope_key(user=run.floor_holder, prefs=True),
    }
```

Intersection, never union. Everything else follows from it:

- **Solo session** — the intersection over `{you}` is your whole clearance. You get Falcon,
  Acme, your private facts, your prefs. Nothing changes from today.
- **Falcon deal room (CEO + CFO)** — both are members of `subject:deal/falcon`, so it
  survives the intersection. Neither person's `user:` compartment does, because the other
  isn't cleared for it.
- **Acme team room** — the sales team is not in Falcon, so `subject:deal/falcon` is not in
  the intersection. The agent does not *decline* to use it; `search()` is **never called
  with that scope key**. There is no retrieval to leak.

The last point is the reason this is worth building rather than prompting for. "Don't mention
Falcon" in a system prompt is a request. Not passing the scope key is a boundary.

> **Now grounded in shipped machinery (2026-07-29):** this same rule was independently
> chosen for *permissions* — a shared run's authority is
> `EffectiveAccess.intersect()` folded over all participants
> ([`groups_sessions_authority.md`](../../ai-company-brain/specs/groups_sessions_authority.md) §3,
> primitive in `packages/acb_auth/acb_auth/permissions.py`). Memory clearance and run
> authority are the same shape applied to two resources: what may be *read into* the run,
> and what the run may *do*. One rule, two enforcement points — credentials via
> `executor._integration_authorizer`, compartments via the scope keys passed to `search()`.

### 3.4 The write rule

> **A fact may be written only to a compartment whose audience is no wider than the session
> where it was learned — unless a human widened it deliberately.**

Three cases:

1. **Default** — write to the narrowest compartment covering the session's audience. A solo
   CEO session writes to `user:vijay`. A room writes to `room:{tid}`.
2. **Bound session** — if the session declares `subject_ref`, facts file into that subject's
   compartment. **Binding a session to a subject is the consent to write there**, which is
   why binding is an explicit act with a confirmation, not an inference (§4.2).
3. **Promote** — widening beyond the session audience is a human action by someone with
   `can_promote`, and the confirmation names every person who gains access.

And the rule that stops the classifier from becoming the leak:

> **Inference may choose *which subject* a fact belongs to. It may never choose an audience
> wider than the session it was learned in.**

Without this, an auto-classifier that files a private CEO remark under `subject:deal/acme`
(audience: sales team) has just published it. With it, the worst an over-eager classifier can
do is file a fact somewhere too narrow — recoverable, and visible in the inspector.

### 3.5 Where this lands in code

| Change | File |
|---|---|
| New scope kinds | `acb_memory/mem0_client.py:50` `scope_key()` + namespace constants |
| Compartment resolution + ACL | new `acb_memory/compartments.py` |
| Read: loop the clearance set instead of one `user_id` | `routes/agent.py:1291` (the `_build_memory_block` closure) |
| Write: resolve the target compartment instead of the caller | `routes/agent.py:1448` `add_memories_background` |
| Memory *tools* write scope | `_set_memory_user_id(user_id)` (`routes/agent.py:1263`) becomes `_set_memory_write_scope(resolved_compartment)` — today it points the `remember`/`save_memory` tools at the caller, which in a room is wrong |
| Authorize the memory API | `routes/memory.py:59,71,84,97` (§2.1) |
| Graphiti grouping | `add_episode(group_id=<scope_key>)` — `graphiti_client.py:187` |
| **Instance-key the file tier** | `agent_blob` PK `(agent_name, path)` → `(agent_name, instance, path)` — [`memory_architecture.md`](../../ai-company-brain/specs/memory_architecture.md) §6.1 |

The read path is the only one with a cost change: N compartment searches instead of one.
Bounded by clearance size (typically 4–6), parallelisable, and absorbed across turns by the
existing `get_session_memory` cache — **whose key must gain the clearance set**, or a room
whose membership changes will serve a block assembled at a wider clearance.

### 3.6 The file tier is the one to get right first

Compartments above are the *vector* tier. There is a second durable tier that is more
dangerous, because it is **injected rather than retrieved**: the curated `agent-data/`
knowledge the framework doc calls *"prompt that grows over time."*

`agent_blob`'s primary key is `(agent_name, path)` — `agent_name` is documented as the only
tenant key — so today there is **one `agent-data/NOTES.md` per agent, shared by every user of
it**, and `recall_notes(path)` with no query returns the whole file. A vector fact leaks only
on a semantic match; the file tier is simply *there*, in full, on every run that loads it.

It needs the same instance key and the same write rule as the compartments, and the two must
land in the same phase — partitioning the vector tier while leaving the file tier shared fixes
the smaller half of the problem. Full design:
[`memory_architecture.md`](../../ai-company-brain/specs/memory_architecture.md).

---

## 4. "Which deal am I on?" — subject resolution

The clearance rule needs to know the subject. Three ways it learns, in descending authority:

### 4.1 Bound room (strongest)

The room declares `subject_ref = 'deal:zoho-4471'`. Deal rooms, incident rooms, and account
rooms are a natural product concept and map onto entities that already exist in `acb_graph`
(`deal`, `customer`, `project`, `person`). Everything is unambiguous: reads include that
subject if the viewers are cleared, writes file there, and the room header names it.

### 4.2 Declared inline

"This is about Falcon" in the composer binds the thread. Because binding changes *write*
targets, it takes a confirmation that names the consequence: *"Facts from this conversation
will be filed under Project Falcon, readable by Vijay and Meera."*

### 4.3 Inferred (weakest, and deliberately one-directional)

Entity linking on the turn against the graph. Subject to one hard constraint:

> **Inference may only narrow reads. It may never add a compartment to the clearance.**

If the agent infers "this is about Falcon" inside a room not cleared for Falcon, it does not
load Falcon memory. What it does instead is the interesting part.

### 4.4 The private hint

When a cleared viewer is in a room that isn't cleared for relevant context, the agent must
not announce that. Saying *"I have information about Project Falcon that I can't use here"*
leaks the existence of Falcon to the room — the breach the compartment was built to prevent.

So the notice is computed per-viewer and delivered on **that viewer's private lane**,
rendered client-side for them alone:

> 🔒 *You have 3 memories about **Project Falcon** that this room can't use.*
> **Ask privately** · **Add this room to Falcon** · **Dismiss**

Everyone else sees nothing — not a redaction marker, not a placeholder. This reuses the
private-lane mechanism from the room RFC (§6.5) and turns the boundary from a silent
degradation into a legible, actionable moment for exactly the person entitled to see it.

---

## 5. The permutations

Every row is the same agent (`agent-sales`) and the same underlying memory. Only the call
changes.

| # | Situation | Viewers | Reads | Writes |
|---|---|---|---|---|
| 1 | CEO solo, Falcon | vijay | `prefs:vijay` · `user:vijay` · `subject:falcon` · `agent:sales` · `org` | `user:vijay` — or `subject:falcon` if the session is bound |
| 2 | Falcon deal room, CEO + CFO | vijay, meera | `prefs:<holder>` · `subject:falcon` · `room` · `agent` · `org` — **neither person's `user:`** | `room` + `subject:falcon` (bound) |
| 3 | CEO joins the Acme team room | sales team + vijay | `prefs:<holder>` · `subject:acme` · `room` · `agent` · `org`. **Falcon is not queried** | `room` + `subject:acme` |
| 4 | Sales rep solo | rep | `prefs:rep` · `user:rep` · subjects they're a member of · `agent` · `org` | `user:rep` |
| 5 | Org-wide room | everyone | `room` · `agent` · `org` only | `room` |
| 6 | CEO's private lane *inside* the Acme room | vijay | Full CEO clearance, **including Falcon** | `user:vijay` — never the room |
| 7 | CEO hands the Falcon room to a rep | — | Blocked. Adding a member to a subject-bound room grants memory access, so it requires `can_promote` and a confirmation naming the count | — |
| 8 | Agent learns tradecraft in the Falcon room | vijay, meera | — | A generalisation with no restricted entity → `agent:sales`. Anything naming Falcon stays in `subject:falcon` (§5.2) |

### 5.1 Why row 2 is the one to check your intuition against

Two people, both fully cleared for the subject, and yet **neither person's private compartment
loads**. That is correct: Meera being cleared for *Falcon* does not make her cleared for
*everything Vijay ever told the agent*. Subject clearance and personal clearance are different
axes, and the intersection rule keeps them separate without anyone having to think about it.

### 5.2 The extraction leak, and the fix

`agent:` and `org:` compartments are org-readable, so extraction into them is the one place a
restricted fact could escape sideways: "Falcon is at $4.2M" is a fact about a deal, but a
naive extractor might file it as general agent knowledge.

The rule: **extraction runs, then every extracted fact is classified. Any fact that references
an entity belonging to a restricted compartment inherits that compartment** and cannot land in
`agent:`/`org:`. Only entity-free generalisations reach the shared compartments. When
classification is uncertain, it files to the narrowest candidate — a fact in the wrong narrow
compartment is a recall miss; a fact in the wrong wide compartment is a breach.

### 5.3 Revocation is forward-only, and we should say so

Removing someone from a compartment stops future reads. It does not un-read what they already
saw, and it does not scrub transcripts they legitimately had access to. The UI must state this
plainly rather than implying a clawback: *"Meera will no longer be able to use these memories.
Conversations she has already seen are unchanged."*

### 5.4 Clearance is fixed at run start

Mirroring acting identity in the room RFC. Two consequences worth building for:

- **You cannot un-see.** If a run has already loaded Falcon into context, someone joining
  mid-run cannot narrow it. So joins are admitted at **run boundaries**; if a run is holding a
  restricted compartment the join queues, and the room shows *"admitting Priya after this
  turn"*. The alternative — letting them in and hoping the model doesn't reference what it
  loaded — is not a boundary.
- **Sharing a conversation that already used restricted memory** cannot retroactively unshare
  it: those facts may be sitting in the transcript above. This is precisely why the history
  waterline defaults to *from here on*, and why the share sheet has to disclose it (§6.2).

---

## 6. UI/UX — going shared, mid-conversation

The moment matters: you are already deep in a chat and you realise this shouldn't be yours
alone.

### 6.1 Five ways in, one sheet

1. **`@mention` in the composer.** Type `@sanjay` mid-message; a chip appears inline; sending
   converts the thread to a room and invites him. The Google Docs move, and the lowest-friction
   path — most sharing should happen this way.
2. **Share button in the thread header** — always present, quiet while solo.
3. **`⌘⇧S`.**
4. **Sidebar row → Share.**
5. **The agent asks.** When a run hits an approval it can't make or a domain it can't act in,
   it can offer: *"This needs Finance sign-off — bring someone in?"* Agent-initiated
   multiplayer is a real moment and costs nothing to support once rooms exist.

All five open the same sheet, because the decisions below are entangled and must be made
together.

### 6.2 The share sheet

Four blocks, in this order:

**People** — who, and at what room role (observer / contributor). Plus the link setting:
invite-only, or anyone at Fracktal with the link.

**History waterline** — *from the beginning* / **from here on** (default) / *pick a point*,
with a live preview of where the divider lands. Implemented by the join cursors already in the
room RFC (`join_stream_id` / `join_message_ts` feeding the existing `?since=` replay and the
`before` window in `_get_messages`).

**What the agent will and won't be able to use** — the block that makes the Falcon case safe,
and the most important disclosure in the feature:

> **This conversation has used memory from:**
> 🔒 **Project Falcon** — restricted · 3 memories · Sanjay is not a member
> ● Acme Corp — 7 memories · Sanjay is a member
> ● Sales agent memory, Company memory
>
> After sharing, the agent **will not** use Project Falcon here.
> ⚠️ **9 messages above your waterline reference Project Falcon.** Sharing from the beginning
> would expose them. → *Keep the waterline here* (recommended) · *Share everything anyway*

This is the disclosure the whole model exists to make possible: it can be computed exactly,
because the clearance set for every past run is known.

**Acting identity** — one line: *the agent will act as vijay@fracktal.in (Zoho, ClickUp)*.

### 6.3 After sharing

- A persistent **waterline divider** in the transcript: *"Sanjay and Priya can see from here ↓
  — shared by you, 10:24."* Everything above is simply never sent to them.
- The header swaps the quiet solo chip for the presence rail and the data banner.
- The composer grows the mode switch: **Turn · Steer · Note · Ask privately**.
- A **restricted-context pill** appears while a run holds a restricted compartment,
  explaining why joins are queued right now.

### 6.4 The memory inspector

The `/memory` page today lists one flat scope. It becomes *"what does this agent know, and who
can see it"*: compartments down the left with kind, label, audience, fact count and a
restricted marker; facts on the right with their source session, date, and audience; and
actions that are honest about their blast radius — **promote** (widen; confirmation names
everyone who gains access and how many facts), **restrict**, **move to another compartment**,
**forget here**, **delete everywhere**.

One view earns its place beyond browsing: **"what would <person> see?"** — pick a teammate and
the inspector greys out everything outside their clearance. That is the check a CEO actually
wants before adding someone to a room.

---

## 7. Phasing

Slots into the room plan in [`README.md`](README.md) §8.

| Phase | Work |
|---|---|
| **0** *(with the room Phase 0)* | ✅ **Authorize `routes/memory.py`** (§2.1) — done 2026-07-30. |
| **3a** | Compartment registry (migration 118) · `scope_key()` kinds · `prefs`/`user` split with a backfill classifier · clearance resolution at run start · read/write rules at the two `routes/agent.py` call sites · `_set_memory_write_scope` |
| **3b** | Subject binding (bound rooms, inline declaration) · entity linking for inference · the private hint on the personal lane · extraction classification (§5.2) |
| **3c** | Share sheet with the memory disclosure · waterline · memory inspector · "what would they see?" |

**Acceptance for 3a** — the load-bearing test: two threads, one agent, one person. Thread A is
bound to a restricted subject; Thread B is a shared room with someone not cleared for it. Assert
that no `search()` call in Thread B's run is ever issued with the restricted scope key — not
that the answer avoids mentioning it. Assert the same for the room after a mid-conversation
share, and that facts from Thread A never appear in any compartment readable by the room.

---

## 8. Open questions

1. **Backfilling the `prefs` / `user` split.** Existing personal memories are one undifferentiated
   bucket. A classifier pass can split them, but the safe default on uncertainty is `user:`
   (private) — which means the agent will seem to forget some preferences until they are
   re-learned. Acceptable, but it should be a deliberate, communicated choice.
2. **Compartment sprawl.** One per deal is a lot of compartments. Auto-create on binding, and
   let unbound subjects share a per-agent default until someone restricts them?
3. **Cross-compartment questions.** "Which of my deals are at risk?" legitimately spans
   compartments the *asker* is cleared for but no single room is. Probably answerable only in a
   solo session or a private lane — worth confirming that is acceptable rather than surprising.
4. **Graphiti's bi-temporal edges** cross entities by design; `group_id` partitions episodes,
   but a traversal could still bridge two compartments. Needs its own pass before Graphiti
   memory is trusted with restricted subjects.
5. **Does `sensitivity='restricted'` need to imply an audit trail on every read?** For a
   Falcon-class compartment, "who asked the agent about this, and when" is probably a thing
   the owner wants. Cheap to add via `acb_audit`; worth deciding early.
