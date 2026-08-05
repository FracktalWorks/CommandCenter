"use client";

// ── The CRM's client store ────────────────────────────────────────────────
//
// zustand, like the tasks and email apps. Deliberately thin: the view state
// lives in the URL (urlState.ts) and the board's geometry is pure
// (board.ts) — what is left here is the server data, the in-flight flags, and
// the one refusal banner.
//
// Rule this store keeps: a refusal must SURFACE and the list must re-read
// (workbench/AGENTS.md — "a control that silently no-ops reads as broken, and
// a stale row after a 409 reads as success"). So every write path sets
// `error` on failure and re-fetches on every response, refusals included.

import { create } from "zustand";
import * as api from "./api";
import { CrmError } from "./api";
import { applyMove, toBoardLanes, type BoardLane, type DealMove } from "./board";
import { listQuery } from "./filters";
import type { CrmView } from "./urlState";
import type {
  Contact,
  Deal,
  DealContact,
  EntitySlug,
  Lead,
  LostReason,
  Organization,
  Status,
  TimelineEntry,
} from "./types";

type Rows = Record<string, unknown>[];

type CrmState = {
  lanes: BoardLane[];
  rows: Rows;
  total: number;
  dealStatuses: Status[];
  leadStatuses: Status[];
  lostReasons: LostReason[];
  /** Loaded lazily for the convert modal's match resolution. */
  contacts: Contact[];
  organizations: Organization[];
  record: Record<string, unknown> | null;
  timeline: TimelineEntry[];
  dealContacts: DealContact[];
  loading: boolean;
  saving: boolean;
  error: string | null;

  setError: (message: string | null) => void;
  loadVocabulary: () => Promise<void>;
  loadBoard: (view: CrmView) => Promise<void>;
  loadList: (entity: EntitySlug, view: CrmView) => Promise<void>;
  loadRecord: (entity: EntitySlug, id: string) => Promise<void>;
  loadDirectories: () => Promise<void>;
  moveDeal: (move: DealMove, extra?: Record<string, unknown>) => Promise<void>;
  patchRecord: (
    entity: EntitySlug,
    id: string,
    body: Record<string, unknown>
  ) => Promise<boolean>;
  createRecord: (
    entity: EntitySlug,
    body: Record<string, unknown>
  ) => Promise<string | null>;
  logActivity: (
    entity: EntitySlug,
    id: string,
    body: Parameters<typeof api.logActivity>[2]
  ) => Promise<void>;
  toggleTask: (
    activityId: string,
    completed: boolean,
    entity: EntitySlug,
    id: string
  ) => Promise<void>;
  convertLead: (
    leadId: string,
    body: Record<string, unknown>
  ) => Promise<string | null>;
  setPrimaryContact: (dealId: string, contactId: string) => Promise<void>;
  detachContact: (dealId: string, contactId: string) => Promise<void>;
};

function message(err: unknown): string {
  if (err instanceof CrmError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export const useCrmStore = create<CrmState>((set, get) => ({
  lanes: [],
  rows: [],
  total: 0,
  dealStatuses: [],
  leadStatuses: [],
  lostReasons: [],
  contacts: [],
  organizations: [],
  record: null,
  timeline: [],
  dealContacts: [],
  loading: false,
  saving: false,
  error: null,

  setError: (error) => set({ error }),

  async loadVocabulary() {
    try {
      const [dealStatuses, leadStatuses, lostReasons] = await Promise.all([
        api.listStatuses("deal"),
        api.listStatuses("lead"),
        api.listLostReasons(),
      ]);
      set({ dealStatuses, leadStatuses, lostReasons });
    } catch (err) {
      set({ error: message(err) });
    }
  },

  async loadBoard(view) {
    set({ loading: true });
    try {
      const pipeline = await api.getPipeline(view.owner);
      set({ lanes: toBoardLanes(pipeline), error: null });
    } catch (err) {
      set({ error: message(err) });
    } finally {
      set({ loading: false });
    }
  },

  async loadList(entity, view) {
    set({ loading: true });
    try {
      const page = await api.listRecords(entity, listQuery(entity, view));
      set({ rows: page.rows, total: page.total, error: null });
    } catch (err) {
      set({ error: message(err), rows: [], total: 0 });
    } finally {
      set({ loading: false });
    }
  },

  async loadRecord(entity, id) {
    set({ record: null, timeline: [], dealContacts: [] });
    try {
      const [record, timeline] = await Promise.all([
        api.getRecord<Record<string, unknown>>(entity, id),
        api.getTimeline(entity, id),
      ]);
      set({ record, timeline: timeline.entries, error: null });
      if (entity === "deals") {
        const people = await api.listDealContacts(id);
        set({ dealContacts: people.rows });
      }
    } catch (err) {
      set({ error: message(err) });
    }
  },

  async loadDirectories() {
    // The convert modal needs enough of the directory to show the match the
    // server would make. Capped at a page: this is a picker, not a mirror.
    try {
      const [contacts, organizations] = await Promise.all([
        api.listRecords<Contact>("contacts", { page_size: 100 }),
        api.listRecords<Organization>("organizations", { page_size: 100 }),
      ]);
      set({ contacts: contacts.rows, organizations: organizations.rows });
    } catch (err) {
      set({ error: message(err) });
    }
  },

  async moveDeal(move, extra = {}) {
    // Optimistic: a card that snaps back for 300ms while a request flies
    // reads as a bug. The previous lanes are kept so a refusal can undo it.
    const previous = get().lanes;
    set({ lanes: applyMove(previous, move), saving: true, error: null });
    try {
      await api.moveDeal(move.dealId, move.toStatusId, extra);
      const pipeline = await api.getPipeline(null);
      set({ lanes: toBoardLanes(pipeline) });
    } catch (err) {
      // Put the card back where it was AND say why. Either alone is a lie.
      set({ lanes: previous, error: message(err) });
    } finally {
      set({ saving: false });
    }
  },

  async patchRecord(entity, id, body) {
    set({ saving: true, error: null });
    try {
      const record = await api.patchRecord<Record<string, unknown>>(
        entity,
        id,
        body
      );
      set({ record });
      return true;
    } catch (err) {
      set({ error: message(err) });
      // Re-read on EVERY response, refusals included: a stale row after a 409
      // reads as success.
      await get().loadRecord(entity, id);
      return false;
    } finally {
      set({ saving: false });
    }
  },

  async createRecord(entity, body) {
    set({ saving: true, error: null });
    try {
      const created = await api.createRecord<{ id: string }>(entity, body);
      return created.id;
    } catch (err) {
      set({ error: message(err) });
      return null;
    } finally {
      set({ saving: false });
    }
  },

  async logActivity(entity, id, body) {
    set({ saving: true, error: null });
    try {
      await api.logActivity(entity, id, body);
    } catch (err) {
      set({ error: message(err) });
    } finally {
      set({ saving: false });
      const timeline = await api.getTimeline(entity, id).catch(() => null);
      if (timeline) set({ timeline: timeline.entries });
    }
  },

  async toggleTask(activityId, completed, entity, id) {
    try {
      await api.completeTask(activityId, completed);
    } catch (err) {
      set({ error: message(err) });
    }
    const timeline = await api.getTimeline(entity, id).catch(() => null);
    if (timeline) set({ timeline: timeline.entries });
  },

  async convertLead(leadId, body) {
    set({ saving: true, error: null });
    try {
      const result = await api.convertLead(leadId, body);
      return result.deal.id;
    } catch (err) {
      set({ error: message(err) });
      return null;
    } finally {
      set({ saving: false });
    }
  },

  async setPrimaryContact(dealId, contactId) {
    set({ saving: true, error: null });
    try {
      await api.addDealContact(dealId, {
        contact_id: contactId,
        is_primary: true,
      });
    } catch (err) {
      set({ error: message(err) });
    } finally {
      set({ saving: false });
      const people = await api.listDealContacts(dealId).catch(() => null);
      if (people) set({ dealContacts: people.rows });
    }
  },

  async detachContact(dealId, contactId) {
    set({ saving: true, error: null });
    try {
      await api.removeDealContact(dealId, contactId);
    } catch (err) {
      set({ error: message(err) });
    } finally {
      set({ saving: false });
      const people = await api.listDealContacts(dealId).catch(() => null);
      if (people) set({ dealContacts: people.rows });
    }
  },
}));

export type { BoardLane, Deal, Lead };
