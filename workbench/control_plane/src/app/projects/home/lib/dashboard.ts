/**
 * Control Center arithmetic — the parts that are decisions, not markup.
 *
 * Spec: `ProjectApp_Plan.md` §14. Pure and colocated-tested, per that
 * document's testing rule.
 */

/**
 * How an attention signal (and a blocker kind) reads on screen.
 *
 * The API returns machine names — `blocked_long`, `no_next_action`,
 * `client_input` — because those are stable and translatable. Turning them
 * into English happens HERE, once, so the attention table and the blocker
 * breakdown cannot end up calling the same thing two different names.
 *
 * `hue` is a shared-vocabulary NAME, resolved through `statusAccent` at the
 * call site — never a class string (AGENTS.md rule 4).
 */
export const SIGNAL_LABELS: Record<string, { label: string; hue: string }> = {
  // attention signals
  critical: { label: "Critical", hue: "red" },
  at_risk: { label: "At risk", hue: "amber" },
  overdue: { label: "Overdue", hue: "red" },
  blocked_long: { label: "Blocked > 1w", hue: "red" },
  blocked: { label: "Blocked", hue: "amber" },
  no_owner: { label: "Unassigned", hue: "violet" },
  no_next_action: { label: "No next action", hue: "amber" },
  stale: { label: "No movement", hue: "gray" },
  // blocker kinds
  client_input: { label: "Client input", hue: "red" },
  client_approval: { label: "Client approval", hue: "red" },
  supplier: { label: "Supplier", hue: "amber" },
  material: { label: "Material", hue: "amber" },
  prototype: { label: "Prototype", hue: "blue" },
  engineering: { label: "Engineering", hue: "blue" },
  information: { label: "Information", hue: "violet" },
  internal_review: { label: "Internal review", hue: "violet" },
  capacity: { label: "Capacity", hue: "amber" },
  dependency: { label: "Dependency", hue: "gray" },
  other: { label: "Other", hue: "gray" },
};

export interface Segment {
  id: string;
  name: string;
  count: number;
  /** Percentage of the whole, for `stroke-dasharray`. */
  pct: number;
  /** Running offset, for `stroke-dashoffset`. */
  offset: number;
  /** `--cat-N` slot, 1-8. */
  slot: number;
  hue: string;
}

/**
 * Turn stage counts into ring segments.
 *
 * Three rules, each from the plan §14's own notes:
 *
 *   • **Empty stages are dropped from the RING** — a zero-width arc is
 *     invisible anyway and its legend entry still carries the fact.
 *   • **Percentages are for drawing only.** The legend shows counts, because
 *     "3 of 29" is a fact and "10.3%" is a rounding.
 *   • **Colour comes from the categorical ramp, by position.** A pipeline stage
 *     has no semantic hue — Prototype is not "worse" than Design — so it is an
 *     identity, not a measurement, which is exactly the `--cat-N` rule
 *     (DESIGN_SYSTEM §1, AGENTS.md rule 7).
 */
export function ringSegments(
  stages: ReadonlyArray<{ id: string; name: string; count: number }>,
): Segment[] {
  const total = stages.reduce((sum, s) => sum + s.count, 0);
  if (total <= 0) return [];

  let offset = 0;
  const out: Segment[] = [];
  for (const [i, s] of stages.entries()) {
    if (s.count <= 0) continue;
    const pct = (s.count / total) * 100;
    out.push({
      id: s.id,
      name: s.name,
      count: s.count,
      pct,
      offset,
      // Slot by POSITION in the pipeline, not by a hash: a pipeline has a
      // running order and adjacent stages reading as adjacent hues is the
      // point. `% 8` because the ramp has eight slots.
      slot: (i % 8) + 1,
      hue: "blue",
    });
    offset += pct;
  }
  return out;
}

/**
 * `jasim@fracktal.in` → `jasim`; `agent:task-manager` → `task-manager`.
 *
 * Display only. The address stays the identity everywhere else (D-PM-4) — this
 * exists because a workload column of full addresses is unreadable at 11px.
 */
export function shortName(actor: string): string {
  if (actor.startsWith("agent:")) return actor.slice("agent:".length);
  const [local] = actor.split("@");
  return local || actor;
}

/**
 * The name to print for a person in a workload row.
 *
 * `shortName` is a LAST resort — it takes the local part of an email, so a real
 * colleague renders as "kiruba" rather than "Kirubakaran S". That is fine for
 * an actor string with nothing behind it (an assignee is free text: D-PM-4
 * allows `email | agent:<name>`, and neither has to be a member), and wrong for
 * anyone who has an `app_user` row.
 *
 * The workload endpoint now returns `name` from `app_user.display_name`, so
 * prefer it and fall back only when there is genuinely nothing better. One
 * helper rather than the same ternary at each call site, because the two
 * surfaces that show people (`/projects/home`'s panel and `/projects/workload`)
 * drifting apart on how a person is named is exactly the kind of split rule 4
 * exists to prevent.
 */
export function personLabel(person: { actor: string; name?: string | null }): string {
  const named = person.name?.trim();
  return named || shortName(person.actor);
}


/**
 * Health model values → what a human reads (D-OPEN-5).
 *
 * The MODEL keeps `healthy | at_risk | critical`; the screen shows words. Kept
 * here rather than in each surface so the list, the panel and any future report
 * cannot end up calling `at_risk` three different things.
 */
export const HEALTH_LABELS: Record<string, { label: string; hue: string }> = {
  healthy: { label: "Healthy", hue: "green" },
  at_risk: { label: "At risk", hue: "amber" },
  critical: { label: "Critical", hue: "red" },
};
