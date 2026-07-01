// Mock GTD data for the UI-first build. Mirrors the demo-data pattern used by
// the email app (lib/mockData.ts): bundled sample data so the /tasks UI is
// fully explorable with no backend. When the gateway `/tasks` API lands, the
// store swaps these for live data; nothing else changes.

import { GtdContext, GtdItem, GtdProject, Person } from "./types";

/** Teammates available for delegation (the Waiting-For directory). */
export const MOCK_PEOPLE: Person[] = [
  { name: "Sai Kumar", email: "sai@fracktal.in", accent: "primary" },
  { name: "Priya", email: "priya@fracktal.in", accent: "accent" },
  { name: "Arjun", email: "arjun@fracktal.in", accent: "primary" },
  { name: "Meera", email: "meera@fracktal.in", accent: "accent" },
];

export const MOCK_CONTEXTS: GtdContext[] = [
  { name: "@computer", icon: "Monitor" },
  { name: "@calls", icon: "Phone" },
  { name: "@errands", icon: "Car" },
  { name: "@office", icon: "Building2" },
  { name: "@home", icon: "Home" },
  { name: "@agenda", icon: "Users" },
];

export const MOCK_PROJECTS: GtdProject[] = [
  {
    id: "p1",
    source: "SYNCED",
    provider: "clickup",
    outcome: "Ship the Quasar X1 firmware 2.0 release",
    purpose: "Unblock 40 customers waiting on the auto-calibration fix.",
    status: "ACTIVE",
    hasNextAction: true,
    areaId: "a-product",
  },
  {
    id: "p2",
    source: "SYNCED",
    provider: "clickup",
    outcome: "Close the Hyderabad lab fit-out",
    purpose: "New lab operational before the Q3 hiring wave.",
    status: "ACTIVE",
    hasNextAction: false, // ← cardinal GTD health-check failure: surfaced in review
    areaId: "a-ops",
  },
  {
    id: "p3",
    source: "LOCAL",
    provider: "local",
    outcome: "Plan parents' 40th anniversary trip",
    purpose: "Personal — just me organising it.",
    status: "ACTIVE",
    hasNextAction: true,
    areaId: "a-personal",
  },
  {
    id: "p4",
    source: "LOCAL",
    provider: "local",
    outcome: "Write the GTD task-manager blog post",
    status: "ACTIVE",
    hasNextAction: true,
    areaId: "a-personal",
  },
];

const now = Date.UTC(2026, 5, 30, 9, 0, 0); // 2026-06-30T09:00:00Z (deterministic)
const iso = (offsetHours: number) => new Date(now + offsetHours * 3600_000).toISOString();

export const MOCK_ITEMS: GtdItem[] = [
  // ── INBOX (unclarified captures) ─────────────────────────────────────────
  {
    id: "i0", source: "LOCAL", provider: "local",
    title: "Follow up on the anodizing vendor samples",
    disposition: "INBOX", isMine: true,
    createdAt: iso(-24 * 6), updatedAt: iso(-24 * 6), // ~a week old → aging signal
  },
  {
    id: "i1", source: "LOCAL", provider: "local",
    title: "Slack from Priya — reschedule the vendor review?",
    disposition: "INBOX", isMine: true,
    createdAt: iso(-2), updatedAt: iso(-2),
  },
  {
    id: "i2", source: "LOCAL", provider: "local",
    title: "Idea: add a 'snooze to next week' button to the inbox",
    disposition: "INBOX", isMine: true,
    createdAt: iso(-5), updatedAt: iso(-5),
  },
  {
    id: "i3", source: "LOCAL", provider: "local",
    title: "Receipt from the Hyderabad flight — file for expenses",
    disposition: "INBOX", isMine: true,
    createdAt: iso(-26), updatedAt: iso(-26),
  },

  // ── NEXT ACTIONS (by @context) ───────────────────────────────────────────
  {
    id: "n1", source: "SYNCED", provider: "clickup",
    title: "Review the calibration PR #214",
    nextAction: "Read the diff and leave review comments on PR #214",
    disposition: "NEXT", context: "@computer", energy: "high",
    timeEstimateMins: 45, projectId: "p1", isMine: true,
    createdAt: iso(-30), updatedAt: iso(-4),
  },
  {
    id: "n2", source: "SYNCED", provider: "clickup",
    title: "Reply to the contractor's lab-quote email",
    nextAction: "Draft a reply approving option B and asking for the timeline",
    disposition: "NEXT", context: "@computer", energy: "low",
    timeEstimateMins: 10, projectId: "p2", isMine: true,
    createdAt: iso(-48), updatedAt: iso(-6),
  },
  {
    id: "n3", source: "LOCAL", provider: "local",
    title: "Call the travel agent about anniversary trip dates",
    nextAction: "Call Meera and confirm the Coorg dates for the trip",
    disposition: "NEXT", context: "@calls", energy: "low",
    timeEstimateMins: 10, projectId: "p3", isMine: true,
    isTwoMinute: false,
    createdAt: iso(-20), updatedAt: iso(-20),
  },
  {
    id: "n4", source: "LOCAL", provider: "local",
    title: "Pick up the soldering tips from the electronics store",
    nextAction: "Buy 3× T18-D24 soldering tips on the way home",
    disposition: "NEXT", context: "@errands", energy: "low",
    timeEstimateMins: 20, isMine: true,
    createdAt: iso(-72), updatedAt: iso(-72),
  },
  {
    id: "n5", source: "LOCAL", provider: "local",
    title: "Outline the GTD blog post",
    nextAction: "Sketch the 5-step section headings in the draft doc",
    disposition: "NEXT", context: "@computer", energy: "medium",
    timeEstimateMins: 30, projectId: "p4", isMine: true,
    createdAt: iso(-10), updatedAt: iso(-10),
  },
  {
    id: "n6", source: "SYNCED", provider: "clickup",
    title: "Agenda: discuss Q3 hiring plan with Arjun",
    nextAction: "Raise the 2 firmware hires at the next 1:1 with Arjun",
    disposition: "NEXT", context: "@agenda", energy: "low",
    isMine: true,
    createdAt: iso(-15), updatedAt: iso(-15),
  },

  // ── WAITING FOR (delegated / blocked on others) ──────────────────────────
  {
    id: "w1", source: "SYNCED", provider: "clickup",
    title: "Firmware QA sign-off on build 2.0-rc3",
    disposition: "WAITING", projectId: "p1", isMine: false,
    waitingOn: { name: "Sai Kumar", email: "sai@fracktal.in", accent: "primary" },
    delegatedAt: iso(-96),
    dueAt: iso(24),
    createdAt: iso(-96), updatedAt: iso(-50),
  },
  {
    id: "w2", source: "SYNCED", provider: "clickup",
    title: "Contractor to send the revised lab fit-out quote",
    disposition: "WAITING", projectId: "p2", isMine: false,
    waitingOn: { name: "BuildRight Co.", accent: "accent" },
    delegatedAt: iso(-168),
    dueAt: iso(-24), // overdue → flagged in the UI
    createdAt: iso(-168), updatedAt: iso(-168),
  },

  // ── CALENDAR (hard-date actions — a VIEW, not a bucket) ───────────────────
  {
    id: "c1", source: "SYNCED", provider: "clickup",
    title: "Quasar X1 2.0 go/no-go release call",
    nextAction: "Join the release call and make the ship decision",
    disposition: "NEXT", context: "@calls", energy: "high",
    projectId: "p1", isMine: true,
    dueAt: iso(31), isHardDate: true,
    createdAt: iso(-40), updatedAt: iso(-40),
  },
  {
    id: "c2", source: "LOCAL", provider: "local",
    title: "Dentist appointment",
    disposition: "NEXT", context: "@errands",
    isMine: true,
    dueAt: iso(54), isHardDate: true,
    createdAt: iso(-200), updatedAt: iso(-200),
  },

  // ── SOMEDAY / MAYBE (incubated) ──────────────────────────────────────────
  {
    id: "s1", source: "LOCAL", provider: "local",
    title: "Learn KiCad properly",
    disposition: "SOMEDAY", isMine: true,
    createdAt: iso(-500), updatedAt: iso(-500),
  },
  {
    id: "s2", source: "LOCAL", provider: "local",
    title: "Evaluate moving the lab to a bigger space next year",
    disposition: "SOMEDAY", isMine: true,
    createdAt: iso(-400), updatedAt: iso(-400),
  },
];

/** A curated subset of David Allen's Incompletion Trigger List — memory-joggers
 *  shown during a mind sweep to help pull open loops out of your head. */
export const GTD_TRIGGERS: string[] = [
  "Projects started, not finished",
  "Projects to start",
  "Promises to others",
  "Calls to make",
  "Emails to send",
  "Decisions to make",
  "Waiting-for / follow-ups",
  "Errands & home",
  "Finances",
  "Health",
];

/** Quick-action pills for the assistant rail (wired in a later slice). */
export const QUICK_ACTIONS: { label: string; prompt: string }[] = [
  { label: "Process my inbox", prompt: "Help me clarify my inbox items one by one." },
  { label: "What's my next action?", prompt: "Given my contexts and energy, what should I do next?" },
  { label: "Run weekly review", prompt: "Walk me through my weekly review." },
  { label: "What am I waiting on?", prompt: "Show me everything I'm waiting on and what's overdue." },
];
