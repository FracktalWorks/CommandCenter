"use client";

/**
 * Projects · bring a real ClickUp workspace in (WS-27b's missing UI).
 *
 * The endpoints shipped with WS-27b and have never been reachable: the empty
 * state said "import a ClickUp workspace" and there was no control anywhere in
 * the product that did it. This is that control.
 *
 * **Three steps, and the first two write nothing.**
 *
 *   1. *Preview* — `POST /import/clickup/plan`. Reads the live ClickUp tenant
 *      and lists every Space with its folders, lists, tasks and people, plus a
 *      proposed Center and the evidence for it. Writes nothing.
 *   2. *Dry run* — `POST /import/clickup {dry_run: true}`. Exercises the whole
 *      import path, including the Space→Folder→List flattening, and reports
 *      what it WOULD create. Writes nothing.
 *   3. *Import* — the same call with `dry_run: false`. This one writes, the
 *      button says so, and it is the only step that does.
 *
 * **The mapping stays the owner's act** (D-PM-10). A wrong auto-map grants a
 * Center visibility of another department's work — the one error class this app
 * cannot make silently — so the suggestion is pre-filled and shown with its
 * reasoning, and every Space is overridable before anything is written.
 */

import { useCallback, useEffect, useState } from "react";

import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";

import { type TaskAccountRow, importApi } from "../lib/api";
import {
  type ImportPlan,
  type ImportSummary,
  centerChoices,
  confidenceLabel,
  describeSummary,
  initialMapping,
  toMappings,
  totals,
  unmappedNotice,
} from "../lib/importPlan";

const FIELD =
  "rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary/50";

export function ImportClickUp({
  onClose,
  onImported,
}: {
  onClose: () => void;
  /** Refresh the tree — the whole point is that projects appear behind this. */
  onImported: () => void;
}) {
  const [accounts, setAccounts] = useState<TaskAccountRow[] | null>(null);
  const [accountId, setAccountId] = useState("");
  const [useLlm, setUseLlm] = useState(true);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState<
    null | "plan" | "dry" | "import" | "mirror"
  >(null);
  const [department, setDepartment] = useState("Company");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const rows = (await importApi.accounts()).filter(
          (a) => a.provider === "clickup",
        );
        if (!live) return;
        setAccounts(rows);
        if (rows.length === 1) setAccountId(rows[0].id);
      } catch (err) {
        if (live) setError(String((err as Error).message));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const preview = useCallback(async () => {
    setBusy("plan");
    setError(null);
    setSummary(null);
    try {
      const result = (await importApi.plan(accountId, useLlm)) as ImportPlan;
      setPlan(result);
      setMapping(initialMapping(result));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [accountId, useLlm]);

  const run = useCallback(
    async (dryRun: boolean) => {
      setBusy(dryRun ? "dry" : "import");
      setError(null);
      try {
        const result = (await importApi.run(
          accountId,
          toMappings(mapping),
          dryRun,
        )) as ImportSummary;
        setSummary(result);
        if (!dryRun) {
          setDone(true);
          onImported();
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [accountId, mapping, onImported],
  );

  /**
   * The fast path: everything the Tasks app already mirrors, under one
   * department. No ClickUp call and no mapping decision — the department split
   * is a later, reversible move, and being forced to decide it before seeing
   * the data is backwards.
   */
  const fromTasks = useCallback(
    async (dryRun: boolean) => {
      setBusy("mirror");
      setError(null);
      try {
        const result = await importApi.fromTasks(department, dryRun);
        setSummary({
          dry_run: result.dry_run,
          projects: result.projects,
          tasks: result.tasks,
          statuses_created: result.lanes_created,
          grants_applied: [],
          unmapped_spaces: [],
          parity: [],
        });
        if (!dryRun) {
          setDone(true);
          onImported();
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [department, onImported],
  );

  const counts = plan ? totals(plan) : null;
  const notice = plan ? unmappedNotice(mapping) : null;

  return (
    // WS-27ak — the hand-rolled scrim, its click-away and the bespoke header
    // are the Modal's now. The backdrop dismissal it had was `pointerdown`-ish
    // by construction (one `onClick` on the scrim); the substrate's is
    // `intentional`, so a selection dragged off this form no longer closes it.
    <Modal
      open
      onClose={onClose}
      title="Bring your work in"
      description="Every Preview writes nothing. Only the buttons that say so write."
      size="3xl"
      className="max-h-[88vh]"
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {/* ── The fast path, offered FIRST ──────────────────────────────
            Everything the Tasks app already mirrors, under one department.
            It is first because it is what somebody with an empty board
            actually wants: no token, no tenant read, no mapping decision.
            Splitting into real departments later is a `/move` per subtree,
            because each child remembers its ClickUp Space. */}
        <section className="rounded-md border border-border p-3">
          <h3 className="text-xs font-medium text-foreground">
            Everything already synced, under one department
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Uses the ClickUp data the Tasks app has already pulled down — no
            ClickUp call, no mapping to decide. Split it into real departments
            whenever you like; each project remembers which Space it came
            from, so that is a move rather than a re-import.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              Department
              <input
                value={department}
                aria-label="Department name"
                onChange={(e) => setDepartment(e.target.value)}
                className={FIELD}
              />
            </label>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "mirror"}
              disabled={busy !== null || !department.trim()}
              onClick={() => fromTasks(true)}
            >
              Preview — writes nothing
            </Button>
            <Button
              size="sm"
              icon="Download"
              loading={busy === "mirror"}
              disabled={busy !== null || !department.trim()}
              onClick={() => fromTasks(false)}
            >
              Bring it all in
            </Button>
          </div>
        </section>

        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            Or import from ClickUp directly, mapping Spaces to Centers
          </summary>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Reads the live tenant. Slower, needs a working token, and asks you
            to decide who can see each Space — the right shape for the real
            migration.
          </p>
          <div className="mt-2 space-y-3">
        {/* ── Step 1: which workspace ───────────────────────────────── */}
        {accounts === null ? (
          <p className="text-xs text-muted-foreground">Looking for a connected ClickUp account…</p>
        ) : accounts.length === 0 ? (
          // Named precisely: "no account" and "the import is broken" must not
          // look the same, and this one has an obvious fix.
          <p className="text-xs text-foreground">
            No ClickUp account is connected. Connect one in the Tasks app
            first — this import reuses that connection rather than asking for
            a second token.
          </p>
        ) : (
          <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            Workspace
            <select
              value={accountId}
              aria-label="ClickUp account"
              onChange={(e) => {
                setAccountId(e.target.value);
                setPlan(null);
                setSummary(null);
              }}
              className={FIELD}
            >
              <option value="">— pick one —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label || a.workspace_id}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={useLlm}
                onChange={(e) => setUseLlm(e.target.checked)}
              />
              {/* Stated because it costs money and because the plan is
                  perfectly usable without it. */}
              Use the model to suggest Centers (costs budget)
            </label>
            <Button
              size="sm"
              icon="Search"
              loading={busy === "plan"}
              disabled={!accountId || busy !== null}
              onClick={preview}
            >
              Preview — reads ClickUp, writes nothing
            </Button>
          </label>
        )}

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {/* ── Step 2: what is actually there, and where it goes ──────── */}
        {plan && counts ? (
          <>
            <p className="text-xs text-foreground">
              <strong>{counts.spaces}</strong> Spaces ·{" "}
              <strong>{counts.folders}</strong> folders ·{" "}
              <strong>{counts.lists}</strong> lists ·{" "}
              <strong>{counts.tasks}</strong> tasks in workspace{" "}
              {plan.workspace_id}.
            </p>
            <p className="text-[11px] text-muted-foreground">
              A Space becomes a department; folders and lists become
              subprojects beneath it. Pick the Center each Space belongs to —
              that is what decides who can see it, so it is your call and not
              the suggestion&apos;s.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Space</th>
                    <th className="py-1 pr-2 font-medium">Contents</th>
                    <th className="py-1 pr-2 font-medium">Center</th>
                    <th className="py-1 font-medium">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.spaces.map((space) => (
                    <tr key={space.space_id} className="border-t border-border align-top">
                      <td className="py-1.5 pr-2 text-foreground">{space.name}</td>
                      <td className="py-1.5 pr-2 text-muted-foreground">
                        {space.task_count} tasks · {space.list_count} lists ·{" "}
                        {space.assignee_count} people
                      </td>
                      <td className="py-1.5 pr-2">
                        <select
                          value={mapping[space.space_id] ?? ""}
                          aria-label={`Center for ${space.name}`}
                          onChange={(e) =>
                            setMapping((prev) => ({
                              ...prev,
                              [space.space_id]: e.target.value,
                            }))
                          }
                          className={FIELD}
                        >
                          {centerChoices().map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1.5 text-[11px] text-muted-foreground">
                        {confidenceLabel(space.suggestion?.confidence)}
                        {space.suggestion?.evidence?.length ? (
                          <span> — {space.suggestion.evidence[0]}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {notice ? (
              <p className="rounded-md border border-border p-2 text-[11px] text-muted-foreground">
                {notice}
              </p>
            ) : null}
          </>
        ) : null}

          </div>
        </details>

        {/* ── What a run did, or would do ────────────────────────────── */}
        {summary ? (
          <div className="rounded-md border border-border p-2">
            <p className="text-xs text-foreground">
              {summary.dry_run ? "Dry run — nothing was written. " : ""}
              {describeSummary(summary)}
            </p>
            {summary.grants_applied.length ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Grants applied: {summary.grants_applied.join(", ")}
              </p>
            ) : null}
            {summary.unmapped_spaces.length ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Imported with no Center: {summary.unmapped_spaces.join(", ")}
              </p>
            ) : null}
            {summary.parity.length ? (
              // The parity table is the honest check: if ClickUp says 412 and
              // the board shows 300, this is where that shows up.
              <p className="mt-1 text-[11px] text-muted-foreground">
                ClickUp had:{" "}
                {summary.parity
                  .map((p) => `${p.space} ${p.clickup_tasks}`)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}

        {done ? (
          <p className="flex items-center gap-1.5 text-xs text-foreground">
            <Icon name="Check" size={13} /> Imported. Close this and the tree
            on the left will have your departments in it.
          </p>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button variant="ghost" onClick={onClose}>
          {done ? "Done" : "Cancel"}
        </Button>
        {plan && !done ? (
          <>
            <Button
              variant="secondary"
              loading={busy === "dry"}
              disabled={busy !== null}
              onClick={() => run(true)}
            >
              Dry run — writes nothing
            </Button>
            <Button
              icon="Download"
              loading={busy === "import"}
              disabled={busy !== null}
              onClick={() => run(false)}
            >
              Import {plan.spaces.length} Spaces — writes
            </Button>
          </>
        ) : null}
      </footer>
    </Modal>
  );
}
