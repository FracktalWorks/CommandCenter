"use client";

/**
 * The four work dialogs — Pause, Complete, Handoff, Blocker.
 *
 * Spec: `ProjectApp_Plan.md` §20 · API: WS-27bg's work routes.
 *
 * One file, four dialogs, because they are the same object four times: a
 * `Modal`, a short form, one POST, a toast, and a `cc-work-session-changed`
 * announcement. Four files would be four copies of the submit path, and the
 * submit path is where the interesting rules live.
 *
 * ## Every one of them is a real mutation
 *
 * The plan's execution rule: "do not build mock UI disconnected from the
 * backend". Each dialog posts to the route that owns the rule, and the server
 * is what refuses a blank remark — the `required` attributes below are a
 * courtesy that saves a round trip, never the enforcement. A form that
 * validated client-side only would be bypassable by anyone with a fetch call,
 * which §40 forbids by name.
 *
 * ## Why they use `Modal`
 *
 * `Modal` is the only file allowed to import the substrate (D-PM-15). It brings
 * the focus trap, the scroll lock, Escape and focus return — the seventy
 * hand-rolled `fixed inset-0` overlays that predate it had none of those.
 */

import { useState } from "react";

import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Input, { DateInput, Select, Textarea } from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { notifyWorkSessionChanged } from "@/components/WorkTimerDock";

/** The reasons the pause dialog offers, and the blocker each implies. */
export const PAUSE_REASONS: ReadonlyArray<{
  value: string;
  label: string;
  /** `null` = an ordinary pause; a kind = also raise a blocker. */
  blocker: string | null;
}> = [
  { value: "end_of_day", label: "End of day", blocker: null },
  { value: "waiting_for_client", label: "Waiting for client", blocker: "client_input" },
  { value: "waiting_for_material", label: "Waiting for material", blocker: "material" },
  { value: "waiting_for_prototype", label: "Waiting for prototype", blocker: "prototype" },
  { value: "waiting_for_team", label: "Waiting for another team", blocker: "internal_review" },
  { value: "technical_issue", label: "Technical issue", blocker: "engineering" },
  { value: "need_clarification", label: "Need clarification", blocker: "information" },
  { value: "other", label: "Other", blocker: null },
];

export const BLOCKER_KINDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "client_input", label: "Client input" },
  { value: "client_approval", label: "Client approval" },
  { value: "supplier", label: "Supplier" },
  { value: "material", label: "Material" },
  { value: "prototype", label: "Prototype" },
  { value: "engineering", label: "Engineering" },
  { value: "information", label: "Information" },
  { value: "internal_review", label: "Internal review" },
  { value: "capacity", label: "Capacity" },
  { value: "dependency", label: "Dependency" },
  { value: "other", label: "Other" },
];

export interface WorkDialogProps {
  open: boolean;
  onClose: () => void;
  taskId: string;
  taskTitle?: string;
  /** Called after a successful mutation, so the caller can refetch. */
  onDone?: () => void;
}

/**
 * The shared submit path.
 *
 * Returns `true` on success. On failure it surfaces the SERVER's message rather
 * than a generic one: the server's 422 says exactly which rule was broken
 * ("Moving to 'paused' requires a remark saying why"), and replacing that with
 * "Something went wrong" throws away the only useful sentence.
 */
function useSubmit(onClose: () => void, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async (
    path: string,
    body: unknown,
    { title, method = "POST" }: { title: string; method?: string },
  ): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let detail = await res.text();
        try {
          detail = JSON.parse(detail).detail ?? detail;
        } catch {
          /* not JSON — show the raw body, truncated */
        }
        toast.show({
          variant: "error",
          title,
          description: String(detail).slice(0, 220),
        });
        return false;
      }
      notifyWorkSessionChanged();
      onDone?.();
      onClose();
      return true;
    } finally {
      setBusy(false);
    }
  };

  return { busy, submit };
}

/** Shared footer, so the four dialogs cannot drift on button order or labels. */
function Actions({
  busy,
  onClose,
  confirm,
  variant = "primary",
  icon,
}: {
  busy: boolean;
  onClose: () => void;
  confirm: string;
  variant?: "primary" | "destructive";
  icon?: string;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button variant={variant} size="sm" type="submit" icon={icon} loading={busy}>
        {confirm}
      </Button>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

// ── Pause ───────────────────────────────────────────────────────────────────

export function PauseDialog({ open, onClose, taskId, taskTitle, onDone }: WorkDialogProps) {
  const [reason, setReason] = useState("end_of_day");
  const [remark, setRemark] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [resume, setResume] = useState("");
  const { busy, submit } = useSubmit(onClose, onDone);

  const implied = PAUSE_REASONS.find((r) => r.value === reason)?.blocker ?? null;

  return (
    <Modal open={open} onClose={onClose} title="Pause work" icon="Pause" size="md"
      description={taskTitle}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await submit(`/tasks/${taskId}/work/pause`, {
            reason,
            remark,
            next_action: nextAction || null,
            expected_resume: resume || null,
            // A reason that means "somebody else has it" raises the blocker in
            // the same act — otherwise the Blocked view cannot see a project
            // that everybody knows is waiting on the customer.
            blocker_kind: implied,
          }, { title: "Could not pause" });
        }}
      >
        <div className="space-y-3">
          <Field label="Why are you stopping?">
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {PAUSE_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </Select>
          </Field>

          <Field
            label="Remark"
            hint={
              implied
                ? "This also raises a blocker, so the project shows up in Blocked."
                : undefined
            }
          >
            <Textarea
              rows={3}
              required
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="What is the state of it, and what does the next person need to know?"
            />
          </Field>

          <Field label="Next action (optional)">
            <Input
              value={nextAction}
              onChange={(e) => setNextAction(e.target.value)}
              placeholder="Follow up with M&M design team"
            />
          </Field>

          <Field label="Expected resume (optional)">
            <DateInput value={resume} onChange={(e) => setResume(e.target.value)} />
          </Field>
        </div>
        <Actions busy={busy} onClose={onClose} confirm="Pause work" icon="Pause" />
      </form>
    </Modal>
  );
}

// ── Complete ────────────────────────────────────────────────────────────────

export function CompleteDialog({ open, onClose, taskId, taskTitle, onDone }: WorkDialogProps) {
  const [remark, setRemark] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [notify, setNotify] = useState(false);
  const { busy, submit } = useSubmit(onClose, onDone);

  return (
    <Modal open={open} onClose={onClose} title="Complete work" icon="Check" size="md"
      description={taskTitle}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await submit(`/tasks/${taskId}/work/complete`, {
            remark,
            deliverable: deliverable || null,
            notify,
          }, { title: "Could not complete" });
        }}
      >
        <div className="space-y-3">
          <Field label="Final remark">
            <Textarea
              rows={3}
              required
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="What was delivered, and against which revision?"
            />
          </Field>

          <Field label="Deliverable / result (optional)">
            <Input
              value={deliverable}
              onChange={(e) => setDeliverable(e.target.value)}
              placeholder="Z121-FNB-REV-C.step"
            />
          </Field>

          {/* Default OFF (§0.5, no notification spam) — the common case is
              finishing your own work, which nobody needs to be told about. */}
          <Checkbox
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            label="Notify the others on this task"
          />
        </div>
        {/* NOT destructive. Red is the danger colour and must not mark a
            success path — the mock draws this red here and green in the
            dialog, and those two disagree (D-OPEN-4). */}
        <Actions busy={busy} onClose={onClose} confirm="Complete work" icon="Check" />
      </form>
    </Modal>
  );
}

// ── Handoff ─────────────────────────────────────────────────────────────────

export function HandoffDialog({ open, onClose, taskId, taskTitle, onDone }: WorkDialogProps) {
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [due, setDue] = useState("");
  const [keepMe, setKeepMe] = useState(false);
  const { busy, submit } = useSubmit(onClose, onDone);

  return (
    <Modal open={open} onClose={onClose} title="Hand off" icon="ArrowRightLeft" size="md"
      description={taskTitle}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await submit(`/tasks/${taskId}/handoff`, {
            to, reason, message: message || null, due: due || null, keep_me: keepMe,
          }, { title: "Could not hand off" });
        }}
      >
        <div className="space-y-3">
          {/* A plain email field, not a person picker: the picker is WS-27bc's
              `pagedPicker` surface half, which is not built. An input that
              works beats a picker that does not exist, and the server
              validates the address either way. */}
          <Field label="Hand off to" hint="Their work email.">
            <Input
              type="email"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="kiruba@fracktal.in"
            />
          </Field>

          <Field label="Reason">
            <Input
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Prototype ready for fitment"
            />
          </Field>

          <Field label="Message (optional)" hint="This becomes their next action.">
            <Textarea
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Please verify mounting alignment on the vehicle."
            />
          </Field>

          <Field label="Due (optional)">
            <DateInput value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>

          <Checkbox
            checked={keepMe}
            onChange={(e) => setKeepMe(e.target.checked)}
            label="Stay on as a contributor"
          />
        </div>
        <Actions busy={busy} onClose={onClose} confirm="Hand off" icon="ArrowRightLeft" />
      </form>
    </Modal>
  );
}

// ── Blocker ─────────────────────────────────────────────────────────────────

export function BlockerDialog({ open, onClose, taskId, taskTitle, onDone }: WorkDialogProps) {
  const [kind, setKind] = useState("client_input");
  const [title, setTitle] = useState("");
  const [waitingOn, setWaitingOn] = useState("");
  const [description, setDescription] = useState("");
  const { busy, submit } = useSubmit(onClose, onDone);

  return (
    <Modal open={open} onClose={onClose} title="Raise a blocker" icon="OctagonAlert" size="md"
      description={taskTitle}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await submit(`/tasks/${taskId}/blockers`, {
            kind, title, waiting_on: waitingOn || null, description: description || null,
          }, { title: "Could not raise the blocker" });
        }}
      >
        <div className="space-y-3">
          <Field label="What kind?">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {BLOCKER_KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </Select>
          </Field>

          <Field label="Title">
            <Input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Awaiting revised mounting dimensions"
            />
          </Field>

          {/* Free text, not a picker: we wait on customers and suppliers far
              more often than on colleagues, and neither is a row in app_user. */}
          <Field label="Waiting on (optional)" hint="A customer, a supplier, or a colleague.">
            <Input
              value={waitingOn}
              onChange={(e) => setWaitingOn(e.target.value)}
              placeholder="Mahindra & Mahindra"
            />
          </Field>

          <Field label="Detail (optional)">
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <Actions busy={busy} onClose={onClose} confirm="Raise blocker" icon="OctagonAlert" />
      </form>
    </Modal>
  );
}

// ── Resolve ─────────────────────────────────────────────────────────────────

export function ResolveBlockerDialog({
  open, onClose, blockerId, blockerTitle, onDone,
}: {
  open: boolean;
  onClose: () => void;
  blockerId: string;
  blockerTitle?: string;
  onDone?: () => void;
}) {
  const [resolution, setResolution] = useState("");
  const [resume, setResume] = useState(true);
  const { busy, submit } = useSubmit(onClose, onDone);

  return (
    <Modal open={open} onClose={onClose} title="Resolve blocker" icon="CircleCheck" size="md"
      description={blockerTitle}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await submit(`/blockers/${blockerId}/resolve`, { resolution, resume },
            { title: "Could not resolve" });
        }}
      >
        <div className="space-y-3">
          {/* Required by the TABLE as well (`pm_blockers_resolution_check`) —
              three call paths can resolve a blocker and a form check only
              covers the one it is in. */}
          <Field label="How was it resolved?">
            <Textarea
              rows={3}
              required
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="M&M sent the revised drawing on 12 Aug."
            />
          </Field>

          <Checkbox
            checked={resume}
            onChange={(e) => setResume(e.target.checked)}
            label="Put the work back in progress"
          />
        </div>
        <Actions busy={busy} onClose={onClose} confirm="Resolve" icon="CircleCheck" />
      </form>
    </Modal>
  );
}
