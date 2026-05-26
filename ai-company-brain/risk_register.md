# Risk Register — AI Company Brain

> Project: AI Company Brain · Org: Fracktal Works · Date: 2026-05-25
> Scoring: Probability (1=Low / 2=Med / 3=High) · Impact (1=Low / 2=Med / 3=High / 4=Critical)
> Score = P × I · Strategies: Avoid / Transfer / Mitigate / Accept

---

## Heat Map (current state)

| | I=1 Low | I=2 Med | I=3 High | I=4 Critical |
|---|---|---|---|---|
| **P=3 High** | | R-08 | R-01, R-02, R-05 | R-04 |
| **P=2 Med**  | R-12 | R-09, R-13 | R-03, R-06, R-10 | R-11 |
| **P=1 Low**  | R-14 | R-15 | R-07 | |

## Register

### R-01 · Entity resolution failures
- **Category:** Technical · **P=3, I=3, Score=9**
- **Description:** Same person/customer/deal represented as multiple nodes; downstream insights wrong.
- **Trigger:** First multi-source ingest (Phase 1).
- **Mitigation:** Use external system IDs (ClickUp/Zoho/Odoo) as canonical keys; deterministic rules first, LLM fallback for ambiguous cases only; log every merge for audit; manual review queue.
- **Contingency:** Pause ingestion, run targeted dedup batch with human-in-the-loop.
- **Owner:** Engineer B · **Strategy:** Mitigate

### R-02 · Agent hallucinates and produces a confidently wrong answer
- **Category:** Technical · **P=3, I=3, Score=9**
- **Description:** LLM invents a deal status, action item, or task that does not exist; user acts on it.
- **Mitigation:** Schema-validated outputs, citation enforcement (every claim cites a graph node), CrewAI-style hallucination guardrail (second-pass verification), entity-existence checks, refusal-on-uncertainty.
- **Contingency:** Quarantine the agent, audit recent outputs, add regression test, retrain prompts.
- **Owner:** Engineer A · **Strategy:** Mitigate

### R-03 · Mirror drift from source systems (ClickUp/Zoho/Odoo)
- **Category:** Technical · **P=2, I=3, Score=6**
- **Description:** Webhooks lost, race conditions; graph and source disagree silently.
- **Mitigation:** Nightly full-pull reconciler with escalation queue (this is a hard requirement, not optional); per-event idempotency keys; webhook retry with dead-letter queue; staleness metric per entity.
- **Contingency:** Pause writes, full re-sync from source, audit period of divergence.
- **Owner:** Engineer A · **Strategy:** Mitigate

### R-04 · Agent makes unauthorized writes to ClickUp / Zoho / Odoo
- **Category:** Technical / Operational · **P=3, I=4, Score=12 — TOP RISK**
- **Description:** Mis-routed action sends an email to a customer, deletes a task, modifies a deal.
- **Mitigation:** Action Broker is the *only* write path; per-action authority tier; default Suggest+Apply (no autonomous in v1); rollback log; rate limits per action type; sandbox mode for tested skills.
- **Contingency:** Kill switch (env-flag) disables Action Broker; rollback via audit log; user notification.
- **Owner:** Engineer A · **Strategy:** Mitigate (cannot Avoid — writes are core value)

### R-05 · WhatsApp Business API verification delay / rejection
- **Category:** External · **P=3, I=3, Score=9**
- **Description:** Meta verification can take 2–6 weeks; rejected for unclear use case.
- **Mitigation:** Start verification process in Phase 1 (parallel to other work); have OpenBSP or Whapi.cloud as fallback gateway; ensure use case is clearly internal-employee tool.
- **Contingency:** Use n8n with personal WhatsApp account for ingestion-only during pilot; restrict to read-only until verification clears.
- **Owner:** Engineer B + Ops · **Strategy:** Mitigate

### R-06 · Meeting bot fails to join or capture is poor quality
- **Category:** Technical · **P=2, I=3, Score=6**
- **Description:** Bot blocked by Meet/Zoom updates; diarization confuses speakers; transcript unusable.
- **Mitigation:** Start with Recall.ai (managed, they handle platform updates); diarization accuracy explicitly budgeted at 80–90%; require user to review action items before write (Suggest+Apply); track per-meeting capture-success metric.
- **Contingency:** Fall back to user-uploaded recording / manual transcript; degrade to action-item summary from chat log only.
- **Owner:** Engineer A · **Strategy:** Transfer (to Recall.ai), then Mitigate when in-housing to Vexa.

### R-07 · LLM provider outage or API change
- **Category:** External · **P=1, I=3, Score=3**
- **Description:** Anthropic/OpenAI downtime or breaking change blocks all agent operations.
- **Mitigation:** Multi-provider abstraction in tier router; cache prompts; have local Llama-3 as Tier-1 fallback; pin SDK versions.
- **Contingency:** Degrade to read-only mirror + dashboards; queue agent work until restored.
- **Owner:** Engineer A · **Strategy:** Mitigate

### R-08 · LLM cost overruns vs budget
- **Category:** Cost · **P=3, I=2, Score=6**
- **Description:** Naive routing or runaway ambient triggers cause 5–10× expected spend.
- **Mitigation:** Tiered router from day one; hard per-day spend cap with alert; per-agent cost telemetry; deterministic Tier-0 filters before any LLM call; back-pressure on event bus.
- **Contingency:** Reduce ambient frequency; downgrade tiers; pause non-critical agents until tuning.
- **Owner:** Engineer B · **Strategy:** Mitigate

### R-09 · Reconciler escalation queue grows unboundedly
- **Category:** Operational · **P=2, I=2, Score=4**
- **Description:** Daily escalations accumulate faster than humans clear them; ambiguities ignored; drift returns silently.
- **Mitigation:** SLA on queue age (escalate to founder after 7 days); rules-from-resolutions feedback loop (annealer turns repeat resolutions into rules); weekly retro on escalation patterns.
- **Contingency:** Hire short-term ops help; freeze new ingest sources until queue is below threshold.
- **Owner:** Ops lead · **Strategy:** Mitigate

### R-10 · Annealer creates unsafe or wrong skills
- **Category:** Technical · **P=2, I=3, Score=6**
- **Description:** Self-improvement loop crystallises a bad pattern; same wrong action now applied 100× faster.
- **Mitigation:** Annealer is suggest-only; maintainer review gate; gated rollout (10% → 50% → 100%) with success-rate threshold; auto-deprecate skills that drop below threshold; every skill has an explicit revert path.
- **Contingency:** Global "disable annealed skills" kill switch; rollback to last reviewed registry snapshot.
- **Owner:** Engineer A · **Strategy:** Mitigate

### R-11 · Privacy / compliance breach (employee communications)
- **Category:** Legal/Compliance · **P=2, I=4, Score=8**
- **Description:** Capturing employee email/WhatsApp without proper consent or retention policy; data leak.
- **Mitigation:** Written employee consent and policy before Phase 1; retention limits (e.g. 90 days for raw transcripts/messages, indefinite for derived facts only); RBAC from Phase 1; encryption at rest and in transit; quarterly access audit; data residency in India where possible.
- **Contingency:** Disclosure to affected parties, immediate access revocation, post-incident review.
- **Owner:** Founder + legal · **Strategy:** Mitigate (do not Accept)

### R-12 · Two-engineer team becomes a bus factor of 1
- **Category:** Resource · **P=2, I=1, Score=2**
- **Description:** Engineer leaves or is unavailable; project stalls.
- **Mitigation:** All work in code review; documentation as a phase deliverable; cross-pair on each phase (rotate ownership); directives kept up-to-date.
- **Contingency:** Slow but resumable; external contractor as bridge if needed.
- **Owner:** Founder · **Strategy:** Mitigate

### R-13 · ClickUp / Zoho / Odoo structures are messier than expected
- **Category:** Data quality · **P=2, I=2, Score=4**
- **Description:** Inconsistent stages, duplicate accounts, abandoned projects pollute the graph; insights are noisy.
- **Mitigation:** Phase 0 includes a data-quality scan deliverable; surface schema inconsistencies; propose ClickUp/Zoho cleanup PRs to ops; mark low-confidence entities in the graph.
- **Contingency:** Dedicated cleanup sprint between Phase 1 and 2; AI agent assists with bulk re-tagging.
- **Owner:** Engineer B + Ops · **Strategy:** Mitigate

### R-14 · Adoption fails — executives stop using it
- **Category:** Organisational · **P=1, I=1, Score=1** (in this phase — exec is the sponsor)
- **Description:** Tool exists but is ignored; ROI not realised.
- **Mitigation:** Weekly demo in exec meeting; ship "killer use case" early; track engagement metrics; prioritise reducing friction (notification routing, response latency).
- **Contingency:** Pivot to highest-engagement use case; deprioritise others.
- **Owner:** Founder · **Strategy:** Mitigate

### R-15 · Push notification fatigue
- **Category:** UX · **P=1, I=2, Score=2**
- **Description:** Ambient agents over-notify; users mute the channel; signal lost.
- **Mitigation:** Per-user notification budget (e.g. ≤ 5 nudges/day); rank/bundle nudges; allow snooze/mute per source; A/B test notification phrasing.
- **Contingency:** Reduce frequency, add "weekly digest" mode, switch to email-only.
- **Owner:** Engineer A · **Strategy:** Mitigate

---

## Top 5 Risks to Watch Weekly

1. **R-04** Unauthorized writes — drill rollback monthly.
2. **R-01** Entity resolution — track resolution accuracy weekly post-Phase 1.
3. **R-02** Hallucinations — track citation coverage and refusal rate.
4. **R-05** WhatsApp verification — track external dependency status.
5. **R-11** Privacy/compliance — quarterly audit, never let this stale.

## Risks Excluded (intentional Accept)

- **Cost spike from a single experiment** — Acceptable; mitigated by daily cap.
- **Single-LLM-vendor lock-in for Tier-3** — Acceptable; abstraction in router; switching cost = days, not weeks.
- **Latency > 2s on Pull queries** — Acceptable in v1; optimise in v2 if user complains.

## Living Document

This register is reviewed:
- **Weekly** for top 5.
- **End of each phase** in full.
- **On any incident** — incident postmortem updates this file.
