"use client";

import { useMemo, useRef, useState } from "react";
import { X, Loader2, Upload, Check, Plus } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { OrgPerson, OrgPersonWrite } from "../lib/types";

/**
 * PersonEditor — add or edit one HR record: role/title/manager/status/capacity,
 * a chip skills editor (showing each skill's provenance), the ClickUp link, and
 * résumé ingestion (upload PDF/DOCX → skills auto-merge). `person=null` = create.
 */
export function PersonEditor({
  person,
  onClose,
}: {
  person: OrgPerson | null;
  onClose: () => void;
}) {
  const savePerson = useTaskStore((s) => s.savePerson);
  const uploadPersonResume = useTaskStore((s) => s.uploadPersonResume);
  const orgPeople = useTaskStore((s) => s.orgPeople);

  const [name, setName] = useState(person?.name ?? "");
  const [email, setEmail] = useState(person?.email ?? "");
  const [role, setRole] = useState(person?.role ?? "");
  const [title, setTitle] = useState(person?.title ?? "");
  const [department, setDepartment] = useState(person?.department ?? "");
  const [team, setTeam] = useState(person?.team ?? "");
  const [managerId, setManagerId] = useState(person?.managerId ?? "");
  const [status, setStatus] = useState(person?.status ?? "active");
  const [capacity, setCapacity] = useState(
    person?.capacityHoursPerWeek?.toString() ?? ""
  );
  const [load, setLoad] = useState(
    person?.currentLoadHoursPerWeek?.toString() ?? ""
  );
  const [clickupId, setClickupId] = useState(person?.providerUserId ?? "");
  const [skills, setSkills] = useState<string[]>(person?.skills ?? []);
  const [skillInput, setSkillInput] = useState("");
  const skillSource = person?.skillsSource ?? {};

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const managers = useMemo(
    () => orgPeople.filter((p) => p.id !== person?.id),
    [orgPeople, person?.id]
  );

  const addSkill = (raw: string) => {
    const s = raw.trim().toLowerCase();
    if (s && !skills.some((k) => k.toLowerCase() === s)) {
      setSkills((prev) => [...prev, s]);
    }
    setSkillInput("");
  };

  const removeSkill = (s: string) =>
    setSkills((prev) => prev.filter((k) => k !== s));

  const buildBody = (): OrgPersonWrite => ({
    name: name.trim(),
    email: email.trim() || undefined,
    role: role.trim() || undefined,
    title: title.trim() || undefined,
    department: department.trim() || undefined,
    team: team.trim() || undefined,
    managerId: managerId || undefined,
    status,
    skills,
    capacityHoursPerWeek: capacity ? Number(capacity) : undefined,
    currentLoadHoursPerWeek: load ? Number(load) : undefined,
    providerUserId: clickupId.trim() || undefined,
  });

  const save = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await savePerson(person?.id ?? null, buildBody());
      onClose();
    } catch (e) {
      setError((e as Error).message || "Couldn't save.");
      setSaving(false);
    }
  };

  const onResumeFile = async (file: File | undefined) => {
    if (!file || !person?.id) return;
    setUploading(true);
    setNotice(null);
    setError(null);
    try {
      const { addedSkills } = await uploadPersonResume(person.id, file);
      // Reflect the merged skills in the open form too.
      setSkills((prev) => {
        const have = new Set(prev.map((s) => s.toLowerCase()));
        return [...prev, ...addedSkills.filter((s) => !have.has(s.toLowerCase()))];
      });
      setNotice(
        addedSkills.length
          ? `Added ${addedSkills.length} skill${addedSkills.length === 1 ? "" : "s"}: ${addedSkills.join(", ")}`
          : "Résumé parsed — no new skills found."
      );
    } catch (e) {
      setError((e as Error).message || "Couldn't process that résumé.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            {person ? `Edit ${person.name}` : "Add person"}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name *">
              <input value={name} onChange={(e) => setName(e.target.value)}
                className={INPUT} placeholder="Full name" />
            </Field>
            <Field label="Email">
              <input value={email} onChange={(e) => setEmail(e.target.value)}
                className={INPUT} placeholder="name@company.com" />
            </Field>
            <Field label="Title">
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                className={INPUT} placeholder="e.g. Senior Engineer" />
            </Field>
            <Field label="Role">
              <input value={role} onChange={(e) => setRole(e.target.value)}
                className={INPUT} placeholder="e.g. Software Engineer" />
            </Field>
            <Field label="Department">
              <input value={department} onChange={(e) => setDepartment(e.target.value)}
                className={INPUT} placeholder="e.g. Engineering" />
            </Field>
            <Field label="Team">
              <input value={team} onChange={(e) => setTeam(e.target.value)}
                className={INPUT} placeholder="e.g. Platform" />
            </Field>
            <Field label="Manager">
              <select value={managerId} onChange={(e) => setManagerId(e.target.value)}
                className={INPUT}>
                <option value="">— none —</option>
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value)}
                className={INPUT}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="on_leave">On leave</option>
              </select>
            </Field>
            <Field label="Capacity (h/wk)">
              <input value={capacity} onChange={(e) => setCapacity(e.target.value)}
                type="number" min={0} className={INPUT} placeholder="e.g. 40" />
            </Field>
            <Field label="Current load (h/wk)">
              <input value={load} onChange={(e) => setLoad(e.target.value)}
                type="number" min={0} className={INPUT} placeholder="e.g. 20" />
            </Field>
            <Field label="ClickUp user id" full>
              <input value={clickupId} onChange={(e) => setClickupId(e.target.value)}
                className={INPUT} placeholder="Assignment target (numeric id)" />
            </Field>
          </div>

          {/* Skills */}
          <Field label="Skills">
            <div className="flex flex-wrap gap-1.5 rounded-md border border-border bg-background p-2">
              {skills.map((s) => (
                <span
                  key={s}
                  title={`source: ${skillSource[s] ?? "manual"}`}
                  className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-foreground"
                >
                  {s}
                  <button
                    onClick={() => removeSkill(s)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              <div className="flex items-center gap-1">
                <input
                  value={skillInput}
                  onChange={(e) => setSkillInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addSkill(skillInput);
                    }
                  }}
                  placeholder={skills.length ? "add…" : "add a skill…"}
                  className="min-w-[6rem] flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
                />
                {skillInput.trim() && (
                  <button onClick={() => addSkill(skillInput)}
                    className="text-primary hover:opacity-80">
                    <Plus size={12} />
                  </button>
                )}
              </div>
            </div>
          </Field>

          {/* Résumé ingestion */}
          <Field label="Résumé">
            {person ? (
              <div className="space-y-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf,.docx,.txt,.md"
                  onChange={(e) => onResumeFile(e.target.files?.[0])}
                  className="hidden"
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                >
                  {uploading ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Upload size={13} />
                  )}
                  {uploading ? "Parsing résumé…" : "Upload résumé (PDF/DOCX) → auto-update skills"}
                </button>
                {notice && (
                  <div className="flex items-start gap-1.5 text-[11px] text-emerald-500">
                    <Check size={12} className="mt-0.5 flex-shrink-0" /> {notice}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Save this person first, then upload a résumé to auto-extract skills.
              </p>
            )}
          </Field>

          {error && <div className="text-[11px] text-destructive">{error}</div>}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !name.trim()}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            {person ? "Save changes" : "Add person"}
          </button>
        </div>
      </div>
    </div>
  );
}

const INPUT =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary transition-colors";

function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${full ? "col-span-2" : ""}`}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
