"use client";

/**
 * /crm — the native CRM (spec: ai-company-brain/specs/crm_app.md §5).
 *
 * Five tabs over one dataset: the deals kanban (the landing tab) and a list
 * per entity on the shared list contract. The record sheet opens OVER
 * whichever list is showing, driven by `?deal=`/`?lead=`/`?contact=`/
 * `?organization=` — v1 has no saved-views table, so view state lives in the
 * URL and canned views are code.
 *
 * ⚠️ Everything server-shaped lives elsewhere on purpose: the request
 * contract in lib/filters.ts, the board geometry in lib/board.ts, the URL
 * grammar in lib/urlState.ts, the conversion rules in lib/convert.ts — each
 * pure and unit-tested. This file is composition and effects.
 */

import Icon from "@/components/Icon";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import FilterPills from "@/components/FilterPills";
import Tabs from "@/components/Tabs";
import ConvertModal from "./components/ConvertModal";
import KanbanBoard from "./components/KanbanBoard";
import LostReasonModal from "./components/LostReasonModal";
import QuickCreateModal from "./components/QuickCreateModal";
import RecordList from "./components/RecordList";
import RecordSheet from "./components/RecordSheet";
import { boardTotals, needsLostReason, type DealMove } from "./lib/board";
import { activeChip, applyChip, chipsFor } from "./lib/filters";
import { compactMoney } from "./lib/format";
import { useCrmStore } from "./lib/store";
import type { EntitySlug, Lead, Status } from "./lib/types";
import {
  applySort,
  closeRecord,
  openRecord,
  parseView,
  selectTab,
  viewHref,
  type CrmView,
  type SheetParam,
} from "./lib/urlState";

const TABS = [
  { id: "board", label: "Pipeline", icon: "Kanban" },
  { id: "deals", label: "Deals" },
  { id: "leads", label: "Leads" },
  { id: "contacts", label: "Contacts" },
  { id: "organizations", label: "Organizations" },
];

/** Which URL parameter opens a record of each collection. */
const PARAM_FOR: Record<EntitySlug, SheetParam> = {
  deals: "deal",
  leads: "lead",
  contacts: "contact",
  organizations: "organization",
};

function CrmPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = useMemo(
    () => parseView(searchParams.toString()),
    [searchParams]
  );

  const store = useCrmStore();
  const [creating, setCreating] = useState<EntitySlug | null>(null);
  const [converting, setConverting] = useState<Lead | null>(null);
  const [pendingLoss, setPendingLoss] = useState<{
    move: DealMove;
    status: Status;
  } | null>(null);

  /** Every navigation in this app is a URL rewrite — Back closes the sheet. */
  const go = useCallback(
    (next: CrmView) => router.push(viewHref(next), { scroll: false }),
    [router]
  );

  useEffect(() => {
    store.loadVocabulary();
    // Loaded once: the vocabulary is small and every tab needs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view.tab === "board") store.loadBoard(view);
    else store.loadList(view.tab, view);
    // ⚠️ Every field `listQuery` reads has to be in this list, `sort`/`dir`
    // included: a filter the effect does not watch is a control that changes
    // its own appearance and issues no request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view.tab,
    view.q,
    view.statusId,
    view.includeConverted,
    view.owner,
    view.sort,
    view.dir,
  ]);

  useEffect(() => {
    if (view.record) store.loadRecord(view.record.entity, view.record.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.record?.entity, view.record?.id]);

  const listEntity: EntitySlug | null = view.tab === "board" ? null : view.tab;
  const statusesFor = (entity: EntitySlug | null): Status[] =>
    entity === "deals"
      ? store.dealStatuses
      : entity === "leads"
        ? store.leadStatuses
        : [];

  const chips = listEntity
    ? chipsFor(listEntity, statusesFor(listEntity), view)
    : [];

  const totals = boardTotals(store.lanes);

  /** A board drop, or the status pill in the sheet. Same request either way. */
  async function moveDeal(move: DealMove, target: Status) {
    const deal =
      store.lanes.flatMap((l) => l.rows).find((d) => d.id === move.dealId) ??
      (store.record as { id?: string; lost_reason_id?: string | null } | null);
    if (deal && needsLostReason(deal, target)) {
      // Ask before the 422 — the gateway refuses a lost move with no reason
      // before writing any of the transition's three effects.
      setPendingLoss({ move, status: target });
      return;
    }
    await store.moveDeal(move);
    if (view.record) store.loadRecord(view.record.entity, view.record.id);
  }

  async function convert(body: Record<string, unknown>) {
    if (!converting) return;
    const dealId = await store.convertLead(converting.id, body);
    setConverting(null);
    if (dealId) {
      // Land on the deal that was just made: the conversion's whole point is
      // that the work continues there.
      go(openRecord(selectTab(view, "deals"), "deal", dealId));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 sm:px-6 sm:py-4">
        <div>
          <h1 className="text-base font-bold text-foreground sm:text-lg">CRM</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {view.tab === "board"
              ? `${totals.count} open deals · ${compactMoney(totals.amount)} in the pipeline`
              : "Pipeline, leads and customers"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() =>
              view.tab === "board" ? store.loadBoard(view) : store.loadList(view.tab, view)
            }
            className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-secondary tech-transition"
            aria-label="Refresh"
          >
            <Icon name="RefreshCw" className={`w-4 h-4 ${store.loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={() =>
              setCreating(view.tab === "board" ? "deals" : (view.tab as EntitySlug))
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition sm:px-4"
          >
            <Icon name="Plus" className="w-4 h-4" />
            New
          </button>
        </div>
      </header>

      <Tabs
        tabs={TABS}
        activeTab={view.tab}
        onTabChange={(id) => go(selectTab(view, id as CrmView["tab"]))}
        variant="underline"
      />

      {chips.length > 0 && (
        <FilterPills
          items={chips}
          activeId={activeChip(view)}
          onChange={(id) => go(applyChip(view, id))}
        />
      )}

      {store.error && (
        // A refusal must surface: a control that silently no-ops reads as
        // broken, and a stale row after a 409 reads as success.
        <div className="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2">
          <p className="flex-1 text-xs text-destructive">{store.error}</p>
          <button
            onClick={() => store.setError(null)}
            className="text-destructive/70 hover:text-destructive"
            aria-label="Dismiss"
          >
            <Icon name="X" className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {view.tab === "board" ? (
        <KanbanBoard
          lanes={store.lanes}
          loading={store.loading}
          onMove={moveDeal}
          onOpen={(id) => go(openRecord(view, "deal", id))}
          onCreate={() => setCreating("deals")}
        />
      ) : (
        <RecordList
          entity={view.tab}
          rows={store.rows}
          total={store.total}
          loading={store.loading}
          sort={view.sort}
          direction={view.dir}
          onSort={(key) => go(applySort(view, key))}
          onOpen={(id) => go(openRecord(view, PARAM_FOR[view.tab as EntitySlug], id))}
        />
      )}

      {view.record && (
        <RecordSheet
          entity={view.record.entity}
          record={store.record}
          statuses={statusesFor(view.record.entity)}
          timeline={store.timeline}
          dealContacts={store.dealContacts}
          saving={store.saving}
          onClose={() => go(closeRecord(view))}
          onPatch={(body) =>
            store.patchRecord(view.record!.entity, view.record!.id, body)
          }
          onMoveStatus={(statusId) => {
            const target = statusesFor(view.record!.entity).find(
              (s) => s.id === statusId
            );
            if (!target) return;
            if (view.record!.entity === "deals") {
              moveDeal(
                {
                  dealId: view.record!.id,
                  fromStatusId: (store.record?.status_id as string) ?? null,
                  toStatusId: statusId,
                },
                target
              );
            } else {
              store.patchRecord(view.record!.entity, view.record!.id, {
                status_id: statusId,
              });
            }
          }}
          onLog={(body) =>
            store.logActivity(view.record!.entity, view.record!.id, body)
          }
          onToggleTask={(activityId, completed) =>
            store.toggleTask(
              activityId,
              completed,
              view.record!.entity,
              view.record!.id
            )
          }
          onConvert={() => {
            store.loadDirectories();
            setConverting(store.record as unknown as Lead);
          }}
          onSetPrimary={(contactId) =>
            store.setPrimaryContact(view.record!.id, contactId)
          }
          onDetach={(contactId) =>
            store.detachContact(view.record!.id, contactId)
          }
          onOpenContact={(contactId) => go(openRecord(view, "contact", contactId))}
        />
      )}

      {creating && (
        <QuickCreateModal
          entity={creating}
          saving={store.saving}
          onClose={() => setCreating(null)}
          onCreate={async (body) => {
            const entity = creating;
            const id = await store.createRecord(entity, body);
            setCreating(null);
            if (id) go(openRecord(view, PARAM_FOR[entity], id));
          }}
        />
      )}

      {converting && (
        <ConvertModal
          lead={converting}
          contacts={store.contacts}
          organizations={store.organizations}
          saving={store.saving}
          onClose={() => setConverting(null)}
          onConvert={convert}
        />
      )}

      {pendingLoss && (
        <LostReasonModal
          statusName={pendingLoss.status.name}
          reasons={store.lostReasons}
          saving={store.saving}
          onCancel={() => setPendingLoss(null)}
          onConfirm={async (payload) => {
            const { move } = pendingLoss;
            setPendingLoss(null);
            // The reason travels WITH the move — one PATCH that either lands
            // or does not, rather than two that can half-apply.
            await store.moveDeal(move, payload);
            if (view.record) store.loadRecord(view.record.entity, view.record.id);
          }}
        />
      )}
    </div>
  );
}

export default function CrmPage() {
  return (
    <Suspense fallback={null}>
      <CrmPageInner />
    </Suspense>
  );
}
