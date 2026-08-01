# Multiplayer Prior Art — Learnings from `qm` (yc-software)

> **Status:** Analysis complete; three findings annealed into existing workstreams, **no code yet** ·
> **Created:** 2026-08-01 · **Owner:** vjvarada
> **Source:** [`github.com/yc-software/qm`](https://github.com/yc-software/qm) — "a multiplayer agent
> harness for work", MIT, TypeScript/Fastify/Postgres. Created **2026-07-29**; ~2.7k stars in three
> days. Read at commit `7f2c916`.
> **Companions:** [`competitive_hardening_2026-07.md`](competitive_hardening_2026-07.md) (this doc's
> sibling — same job, different competitor set), [`../../docs/multiplayer/README.md`](../../docs/multiplayer/README.md)
> (rooms), [`../../docs/multiplayer/memory-clearance.md`](../../docs/multiplayer/memory-clearance.md)
> (compartments + clearance), [`groups_sessions_authority.md`](groups_sessions_authority.md) (the
> binding authority decisions), [`skills_scope_out.md`](skills_scope_out.md) (WS-23 token wall).

This doc exists for the same reason its sibling does: so the findings are **actionable later**, not
lost in a comparison. It adds no new workstream. Its job is to (1) attach a *proven external
reference implementation* to three things we have already designed, and (2) record the one place
where an outside team independently reproduced our most contested decision.

**Read the age caveat first.** qm is three days old. "Shipped" here means *released*, not
*battle-tested*. Its own `SECURITY.md` (`:26-33`) says QM "is **not** a hardened public or
multi-tenant service boundary" and "assumes one organization of authenticated internal users" —
the same posture we are in. Nothing below should be read as "they solved it in production."

---

## Verdict (category framing — read this first)

**qm is the closest prior art to our multiplayer work that exists, and it is a genuinely different
product shape.** In qm there is *one* company assistant, and a "scope" is a place — a person's DM, a
Slack channel, a project. The scope owns everything: memory, files, sandbox, crons, keychain view,
skills. In CommandCenter there is a *fleet* of named agents, and a room is a `chat_session` several
people stand in. That difference decides what transfers.

- **Our memory model is a generation ahead.** Subject compartments express a case qm structurally
  cannot ([§QM-D1](#qm-d1--subject-compartments-are-the-thing-they-cannot-express)).
- **Their concurrency model and their skills-injection model are a generation ahead of ours**, and
  both land on live workstreams (WS-10, WS-23).
- **The most valuable finding is not an idea — it is a confirmation.** They reached our
  least-cleared-viewer rule independently, three times, for three different resources
  ([§QM-0](#qm-0--the-convergence-intersection-is-not-just-our-idea)).

We out-design them on memory; they out-implement us on the turn loop. Same conclusion the sibling
doc reached about Hermes and OpenClaw, for the same reason: designs are cheap, loops are not.

---

## QM-0 — The convergence: intersection is not just our idea

[`memory-clearance.md` §3.3](../../docs/multiplayer/memory-clearance.md) states *"a run reads at the
clearance of its least-cleared viewer"*, and [`groups_sessions_authority.md`](groups_sessions_authority.md) §3
states the permissions twin — a shared run acts at `EffectiveAccess.intersect()` over all
participants. Both were contested during design; both are the reason the room model is safe.

qm arrived at the identical rule independently, and applied it to **three** resources:

| Resource | qm mechanism | File |
|---|---|---|
| Transcript replay into the model | an entry is replayed only if `audience.every(entitled)` | `src/resolution/context-filter.ts:18-28` |
| **Network egress** | allowed hosts = **intersection** across the audience; denied hosts = **union** | `src/resolution/audience-floor.ts:39-59` |
| Shared file handles | someone in the audience must be able to *use* it **and** everyone must be allowed to *see* it | `src/acl/acl-store.ts:178-191` |

All three fail closed on an empty audience. Their test names say it outright: *"audienceEgressFloor
for several principals = the INTERSECTION of their reaches"*, *"a deny by anyone applies to the
room"*.

**What this changes for us:** nothing in the rule, and one thing in its reach. We enforce
intersection over *what a run may read* (compartments) and *what it may do* (credentials). qm also
enforces it over *where it may connect*. An audience-intersected **egress floor** is a natural third
enforcement point of a rule we already have, and it belongs with the Action Broker / isolation work
rather than here — noted against **WS-1 / WS-3**, not scheduled.

---

## Gap → work-item map

Legend for **Our state**: ✅ real · ◑ partial/default-off · ⚠️ designed-but-not-built · ✖ absent

| # | Finding | Proven reference (theirs) | Our state | Maps to |
|---|---|---|---|---|
| **QM-1** | **A second person's turn should fold into the live run, not be rejected.** Our answer to the destructive race is a 409 plus five floor-control modes; steering dissolves most of the problem the baton was invented for. | Second message is injected into the running turn as a mid-turn **steer**; a durable signal store carries it cross-process; the second surface stands down so the reply isn't posted twice. | ⚠️ designed (§4.6), unbuilt | **WS-10** (re-scope Phase 2) |
| **QM-2** | **Skills should be injected as a one-line index, with bodies read on demand.** WS-23 measured the floor at ≈15.4k tokens and concluded the ≤2k target needs "a core-floor diet, progressive disclosure". This is that mechanism, implemented. | Prompt gets `- **name** — description → read skills/<name>/SKILL.md`; bodies written to the sandbox; full trees materialized on first tool touch; connector-gated skills filtered out entirely; index sits inside the prompt-cache-stable prefix. | ✖ | **WS-23** (the S3 successor) |
| **QM-3** | **In a shared room nothing should be ambient — every credential needs a grant to *that room*.** Our §6.4 picks a single room-level `acting_identity`; theirs is per-credential, per-room, with a consent protocol. | `materializeStanding(scopeId)` only; grants bound to `(credentialId, audienceScopeId, once\|standing, purpose)`; ask flow with TTL; one-time grants marked used; secret-drop links; broker mode where the agent never sees the secret. | ⚠️ designed (§6.4), unbuilt | **WS-10** Phase 3, **WS-2**, **WS-1** |
| **QM-4** | **A scheduled run needs an acting identity and a membership re-check at fire time.** | `runAs: owner \| scopeShared \| scopeFloor`, plus a live membership check before every run: *"the acting person is no longer a member of this trigger's home scope — run skipped"*. Fails closed on `pending_approval` (no human at fire time). | ✖ | **WS-4**, **WS-21** |
| **QM-5** | **Participant tenure windows constrain what the *model* sees, not just what a viewer sees.** | `participants(valid_from_seq, valid_to_seq)`; the turn's replay is the **intersection** of every current participant's visible window. | ◑ (we have join cursors for rendering) | **WS-10** Phase 3 |
| **QM-6** | **Memory correction as an explicit LLM rewrite loop.** Relevant when WS-9 §6.7 gets picked up. | Consolidation emits `UPDATE n:` / `DELETE n` / `ADD:` actions applied deterministically; a 14-day scratch log is promoted into the durable notebook; provenance suffixes preserved verbatim and never merged across sources. | ✖ | **WS-9** (reference only) |
| **QM-7** | **An explicit, owner-mediated way for two scopes to share one brain.** Answers [`agent-kinds.md`](../../docs/multiplayer/agent-kinds.md) §9 Q1 ("does a personal agent ever learn across its instances?") without pooling raw memory. | "Environments": attaching two scopes to one environment gives them one memory notebook, disk, and sandbox. Attachment is owner-mediated with a refusal that names the owner. | ✖ | **agent-kinds §9 Q1** (design input) |

---

## The three worth taking, in detail

### QM-1 — Steer instead of 409 (WS-10)

[`README.md` §3.3](../../docs/multiplayer/README.md) diagnoses the destructive race correctly: Bob's
message cancels Alice's 40-minute run and deletes its Redis transcript, silently. Our fix is §5.2's
409 plus §5.1's five floor modes (`solo|driver|queue|open|moderated`), budgeted at ~1.5 weeks and
unbuilt.

qm never introduced a baton. Before the session lease is even attempted, a live run on the same
thread is detected and the new message is **injected into it** (`src/api/app-turn.ts:286-350`). The
routing decision is a pure function small enough to quote (`src/wake/wake.ts:20-31`): drop if it's
the agent's own message; engage if nothing is running; `abort` on a bare "stop"; otherwise `steer`.
Two details that make it work in practice and that we would need:

- **The second caller stands down.** The turn result carries `steered: true` and the surface plugin
  suppresses its own delivery — their Slack handler comments that delivering from both sides "is how
  one answer got posted twice."
- **Signals are durable and replayable.** A steer whose target run terminated mid-send is replayed
  into a fresh run rather than lost.
- One carve-out: a human message arriving during an **automation** turn starts its own run instead
  of steering into a cron.

**Recommendation for WS-10:** build steer first, then re-evaluate whether five floor modes still
earn their place. [`README.md` §4.6](../../docs/multiplayer/README.md) already says steer is *"a new
applier, not new infrastructure"* on the existing `cc:control:` bus — the substrate is there. Note
the ordering inversion this implies: §8 sequences Phase 2 as *floor control, then steer*; the
evidence says *steer, then measure whether floor control is still load-bearing*.

Their model does not remove the need for §5.2's correctness fix. `mark_active(reset=True)` must
still be unreachable by a party who isn't legitimately superseding, or a second person can delete a
transcript they don't own. Steering changes what the **default** path is, not whether the
destructive path is reachable.

### QM-2 — Skills as an index, bodies on demand (WS-23)

[`skills_scope_out.md` §5](skills_scope_out.md) closes with the measurement that matters: family
toggles save ≈3.8k tokens (19.3k → 15.4k) and *"getting under 2k is a core-floor diet — fewer/leaner
schemas, progressive disclosure — a different workstream."* qm is a working implementation of
exactly that phrase.

The mechanism has four parts, each independently useful:

1. **Index, not body.** The system prompt gets one line per skill: name, description, and the path to
   read for the rest. Bodies never enter the prompt.
2. **Bodies live on disk.** `SKILL.md` is materialized into the scope's sandbox once per provision;
   full trees (assets, bundles) are laid down lazily, triggered when a tool call actually touches
   the skill's directory. Both layers are content-hash idempotent with marker files.
3. **Connector gating.** Skills for providers the org hasn't configured are filtered out of the
   index entirely, rather than being listed and then failing.
4. **Cache placement.** The index is appended *before* the prompt-cache boundary, so it stays in the
   stable prefix — the same discipline as our [`prompt-caching`](llm_caching_memory.md) choke points.

**What it would cost us.** This is not a config flip. It needs the agent to be able to read the body
from somewhere, which for us means the `agent-data/` blob store or the workspace path rather than a
sandbox filesystem — and the *tool schemas*, which are ≈10.3k of our 15.4k floor, are a separate
problem that an index does not solve. The honest framing: QM-2 attacks the ≈5.4k addendum half of
the floor and proves the pattern; the schema half still needs its own diet.

### QM-3 — Per-credential grants to a room (WS-10 Phase 3 / WS-2)

[`README.md` §6.4](../../docs/multiplayer/README.md) weighs *driver* / *owner* / *room binding* and
picks room binding: one `acting_identity` fixed at room creation, shown in the header. qm picks none
of the three. In a shared scope **nothing is ambient** — not even the speaker's own credentials.
Only standing grants whose audience is *exactly this scope* materialize; connector OAuth tokens are
DM-only; org service credentials require an all-internal audience.

Around that they built a consent protocol worth copying nearly verbatim:

- A grant is bound to `(credentialId, audienceScopeId, mode: once|standing, purpose)` and checked on
  every use: wrong scope → 403, revoked → 410, one-time already used → 410, expired → 410.
- **"Only the owner's OWN reply is approval. A relayed 'they said it's fine' is not."** Core verifies
  the speaker *is* the owner on the turn where approval is spoken.
- Grants cannot be minted on a triggered (non-human) turn.
- A **secret-drop link** so a fresh key is never pasted into chat.
- **Broker delivery**: the agent calls the target by proxy and the secret is injected server-side —
  it never enters the sandbox at all.

This is the fail-closed version of our §6.4 and it is strictly better: `acting_identity` answers
"whose mailbox" with one room-wide setting, where the grant model answers it per credential, with
consent, revocation, and an audit record. It also composes with the Action Broker (**WS-1**) and the
secrets workstream (**WS-2**) rather than sitting beside them.

Their own residual risks are documented and apply equally to us: credentials materialized into a
sandbox are plaintext to any process there, and *"credential purposes are not enforced
authorization"* — the purpose travels as an instruction to the model and an audit field, nothing
determines whether a later command stays within it.

---

## Where we are ahead — and should not regress

### QM-D1 — Subject compartments are the thing they cannot express

qm's memory unit is a **place**. Every fact a person tells the agent lands in that scope's notebook.
So the case [`memory-clearance.md` §1](../../docs/multiplayer/memory-clearance.md) opens with — the
CEO discussing restricted **Project Falcon** and collaborative **Acme** with the same agent — puts
both facts in one `personal:` notebook. When the CEO then joins the Acme channel, qm's protection is
that personal memory is simply never recalled in a channel. Nothing leaks; the agent also forgets
Acme.

That is precisely our `context_policy='room'` failure, which §1 rejects as *"the switch is on the
wrong axis."* Their only mitigation is provenance, not clearance: facts copied into a personal
notebook are tagged `(said in <room>)`, and consolidation may never merge two facts with different
source tags.

To be fair to them, it is the *safe* corner, and [`agent-kinds.md` §3.1](../../docs/multiplayer/agent-kinds.md)
says so itself: an agent wrongly marked shared **leaks**; wrongly marked personal **forgets**. qm
chose forgetting deliberately. **We are ahead on paper and roughly level in shipped reality** —
`subject:` compartments are WS-10 3b and unbuilt.

### The rest of the lead

- **Semantic partition inside the query.** Our Mem0 partition rides `user_id` *inside* the vector
  search, so a compartment we don't pass is never searched. qm has no retrieval at all: one
  markdown notebook, capped at 300 bullets and ~6k chars, injected wholesale. That is a few months
  of one person's use before eviction starts, and every turn pays for all of it.
- **Per-viewer disclosure.** [`memory-clearance.md` §4.4](../../docs/multiplayer/memory-clearance.md)'s
  private hint tells *only the cleared viewer* that restricted context exists. qm degrades silently.
- **The share-mid-conversation moment.** Our share sheet computes "9 messages above your waterline
  reference Project Falcon" because per-run clearance is known. qm has no share moment at all — the
  scope is decided by where you typed.
- **Several agents in one room** (`chat_session_agent`, migration 139). qm is one agent.
- **Clearance-tagged replay.** Migration 139 shipped per-message clearance tags and
  clearance-filtered replay redaction. Their `SECURITY.md:113-116` concedes the gap on the same
  mechanism: *"Model-context entries do not yet carry complete origin labels for every granted read,
  so mixed-permission filtering is incomplete."*

---

## What not to copy

- **Their skill approval flow is nominal.** `SkillStore` models reviewers, approvals and capability
  grants properly, but every production call site reviews under a `system:*` pseudo-reviewer and
  publishes in the same breath; the draft-demotion for shared skills is immediately undone by a
  republish. The only real human gate is org-wide promotion (live org admin, never an autonomous
  trigger). WS-23's admin-gated per-agent toggles are the more real mechanism — keep them.
- **`trustTier` on imported skill packs is stored and never read**, so a third-party pack gets the
  same auto-review as an internal one. If we ever import skill packs, the tier must gate something.
- **Their security postures are mutually exclusive by construction.** `strict` turns content
  screening **off** and substitutes universal tool approvals; `auto` screens but never pauses. There
  is no "screen *and* approve". That is a modeling mistake, not a design; our posture work should
  not inherit it.
- **Fail-open/fail-closed is inconsistent between their screening paths** — mid-turn steers block
  when no screener is configured, tool results fail open with an "unscreened" label. Pick one per
  class of content and state it.
- **Memory capped at 300 bullets.**

### Not a live gap for us (checked, not assumed)

qm labels every compacted summary conservatively, returning *no* safe label when a summary would
span two personal scopes — so their summarizer cannot launder a restricted fact into a wider label.
**We do not have that risk today**: `packages/acb_llm/acb_llm/context.py::fit_messages_to_context`
*truncates* the longest message (head + tail around a marker); it never summarizes. The guardrail is
worth remembering only if WS-9 introduces summarizing compaction — at which point the summary needs
a clearance label chosen by the same conservative rule.

---

## Free steal, unrelated

Their supply-chain gate: `min-release-age=7` in `.npmrc` (npm ≥ 11.10.0) holds newly published
versions out of a lockfile for seven days; `npm ci` in CI is unaffected. Cheap protection against
the compromised-release window. Belongs with **WS-5** (CI gates) if we want it.
