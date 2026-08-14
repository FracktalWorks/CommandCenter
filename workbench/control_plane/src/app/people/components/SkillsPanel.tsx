"use client";

/**
 * People Center · the structured skills & credentials editor (WS-28h).
 *
 * Spec: `project-docs/specs/people_center_app.md` §3.3 · D-PC-6.
 *
 * One row per skill — the level, the years, the recency — because those are
 * the questions assignment actually asks, and three parallel chip lists would
 * be three things that must agree. Saving replaces the whole list; the server
 * rewrites the flat `skills[]` projection in the same transaction, so the
 * chips on every other surface update with it.
 *
 * Two rules inherited from the profile panels:
 * - **Editability comes from the server** (`editable_fields` contains
 *   `skills`) and the level/kind vocabularies arrive on the GET — no client
 *   copy to drift (D-PC-4).
 * - **A refusal renders verbatim** (D-PC-5): the gateway refuses a bad row by
 *   name and applies nothing, and that sentence is the only actionable form.
 */

import { useEffect, useState } from "react";

import Button from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";

import { type PersonDetail, PeopleApiError, peopleApi } from "../lib/api";
import {
  CREDENTIAL_KIND_LABELS,
  type Credential,
  type SkillDetail,
  credentialsToWire,
  describeCredential,
  describeSkill,
  emptyCredential,
  emptySkill,
  seedRows,
  toWire,
} from "../lib/skills";

interface Props {
  person: PersonDetail;
  onSaved?: () => void;
}

export function SkillsPanel({ person, onSaved }: Props) {
  const editable = (person.editable_fields ?? []).includes("skills");
  const target = person.is_self ? "me" : person.id;

  const [rows, setRows] = useState<SkillDetail[] | null>(null);
  const [creds, setCreds] = useState<Credential[] | null>(null);
  const [levels, setLevels] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editable) return;
    let live = true;
    (async () => {
      try {
        const res = await peopleApi.skills(target);
        if (!live) return;
        setRows(seedRows(res.skills, person.skills));
        setCreds(res.credentials.map((c) => ({ ...c })));
        setLevels(res.levels);
        setKinds(res.credential_kinds);
      } catch (err) {
        if (live) setError((err as Error).message);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on row change only
  }, [editable, target, person.id]);

  // Read-only: render from the person payload, no extra fetch.
  if (!editable) {
    const detail = person.skills_detail ?? [];
    const credentials = person.credentials ?? [];
    if (detail.every((r) => !describeSkill(r)) && credentials.length === 0) {
      return null; // nothing structured to show — the flat chips already render
    }
    return (
      <section className="border-b border-border p-3">
        <h3 className="mb-1 text-xs font-medium text-foreground">
          Capability detail
        </h3>
        <ul className="flex flex-col gap-0.5">
          {detail.filter((r) => describeSkill(r)).map((r) => (
            <li key={r.skill} className="text-xs text-muted-foreground">
              <span className="text-foreground">{r.skill}</span>
              {" · "}
              {describeSkill(r)}
            </li>
          ))}
        </ul>
        {credentials.length > 0 && (
          <ul className="mt-2 flex flex-col gap-0.5">
            {credentials.map((c) => (
              <li key={c.id ?? c.title} className="text-xs text-muted-foreground">
                <span className="text-[10px] uppercase">
                  {CREDENTIAL_KIND_LABELS[c.kind] ?? c.kind}
                </span>{" "}
                {describeCredential(c)}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  if (error && rows === null) {
    return (
      <section className="border-b border-border p-3">
        <p className="text-xs text-destructive" role="alert">{error}</p>
      </section>
    );
  }
  if (rows === null || creds === null) {
    return (
      <section className="border-b border-border p-3">
        <p className="text-xs text-muted-foreground">Loading skills…</p>
      </section>
    );
  }

  function setRow(index: number, patch: Partial<SkillDetail>) {
    setRows((prev) =>
      (prev ?? []).map((r, i) => (i === index ? { ...r, ...patch } : r))
    );
  }

  function setCred(index: number, patch: Partial<Credential>) {
    setCreds((prev) =>
      (prev ?? []).map((c, i) => (i === index ? { ...c, ...patch } : c))
    );
  }

  async function saveSkills() {
    setBusy(true);
    setError(null);
    try {
      const res = await peopleApi.saveSkills(target, toWire(rows ?? []));
      setRows(res.skills.map((r) => ({ ...r })));
      onSaved?.();
    } catch (err) {
      // The gateway names the offending row; shown verbatim (D-PC-5).
      setError(
        err instanceof PeopleApiError ? err.message : String((err as Error).message)
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveCredentials() {
    setBusy(true);
    setError(null);
    try {
      const res = await peopleApi.saveCredentials(
        target, credentialsToWire(creds ?? []));
      setCreds(res.credentials.map((c) => ({ ...c })));
      onSaved?.();
    } catch (err) {
      setError(
        err instanceof PeopleApiError ? err.message : String((err as Error).message)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-b border-border p-3">
      <h3 className="mb-1 text-xs font-medium text-foreground">
        Skills — level, years, last used
      </h3>
      <p className="mb-2 text-[11px] text-muted-foreground">
        What the assignment suggester reads. A skill without a level still
        counts; a level makes the match honest.
      </p>

      {error && (
        <p className="mb-2 text-xs text-destructive" role="alert">{error}</p>
      )}

      <div className="flex flex-col gap-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-center gap-1.5">
            <Input
              inputSize="sm"
              className="w-36"
              placeholder="Skill"
              value={row.skill}
              onChange={(e) => setRow(index, { skill: e.target.value })}
            />
            <Select
              inputSize="sm"
              value={row.level ?? ""}
              onChange={(e) =>
                setRow(index, { level: e.target.value || null })
              }
            >
              <option value="">not assessed</option>
              {levels.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </Select>
            <Input
              inputSize="sm"
              className="w-16"
              type="number"
              step="0.5"
              min="0"
              placeholder="yrs"
              value={row.years ?? ""}
              onChange={(e) =>
                setRow(index, {
                  years: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
            <Input
              inputSize="sm"
              className="w-20"
              type="number"
              placeholder="last used"
              value={row.last_used_year ?? ""}
              onChange={(e) =>
                setRow(index, {
                  last_used_year:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
            {row.evidence === "resume" && (
              <span className="text-[10px] text-muted-foreground">from CV</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              icon="X"
              aria-label={`Remove ${row.skill || "skill"}`}
              onClick={() =>
                setRows((prev) => (prev ?? []).filter((_, i) => i !== index))
              }
            />
          </div>
        ))}
      </div>

      <div className="mt-2 flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon="Plus"
          onClick={() => setRows((prev) => [...(prev ?? []), emptySkill()])}
        >
          Add skill
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void saveSkills()}>
          Save skills
        </Button>
      </div>

      <h3 className="mb-1 mt-4 text-xs font-medium text-foreground">
        Education, certifications & prior roles
      </h3>
      <div className="flex flex-col gap-1.5">
        {creds.map((cred, index) => (
          <div key={index} className="flex flex-wrap items-center gap-1.5">
            <Select
              inputSize="sm"
              value={cred.kind}
              onChange={(e) => setCred(index, { kind: e.target.value })}
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {CREDENTIAL_KIND_LABELS[kind] ?? kind}
                </option>
              ))}
            </Select>
            <Input
              inputSize="sm"
              className="w-44"
              placeholder="Title"
              value={cred.title}
              onChange={(e) => setCred(index, { title: e.target.value })}
            />
            <Input
              inputSize="sm"
              className="w-36"
              placeholder="Institution / employer"
              value={cred.issuer ?? ""}
              onChange={(e) =>
                setCred(index, { issuer: e.target.value || null })
              }
            />
            <Input
              inputSize="sm"
              className="w-18"
              type="number"
              placeholder="from"
              value={cred.year_from ?? ""}
              onChange={(e) =>
                setCred(index, {
                  year_from:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
            <Input
              inputSize="sm"
              className="w-18"
              type="number"
              placeholder="to"
              value={cred.year_to ?? ""}
              onChange={(e) =>
                setCred(index, {
                  year_to: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
            <Button
              variant="ghost"
              size="sm"
              icon="X"
              aria-label={`Remove ${cred.title || "credential"}`}
              onClick={() =>
                setCreds((prev) => (prev ?? []).filter((_, i) => i !== index))
              }
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon="Plus"
          onClick={() =>
            setCreds((prev) => [...(prev ?? []), emptyCredential()])
          }
        >
          Add credential
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void saveCredentials()}>
          Save credentials
        </Button>
      </div>
    </section>
  );
}

export default SkillsPanel;
