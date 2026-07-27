"use client";

/**
 * ContactCard — the people card behind a sender's name or avatar.
 *
 * Clicking any display name / avatar in the mail app pops a card with who the
 * person is (address, signature-derived phone / title / company), how the
 * correspondence has gone, and their last few messages as small preview cards
 * that open on click — the Outlook people-card affordance.
 *
 * `ContactTrigger` is the only thing callers touch: wrap whatever already shows
 * the person (an avatar circle, a name span, a recipient in the To: line) and
 * it becomes the anchor. It renders a real <button>, so it is safe to place
 * inside a clickable row as long as that row is a div — the trigger stops
 * propagation so opening the card never also toggles the row.
 *
 * The popover portals to <body> so the scrolling reading pane can't clip it,
 * and positions itself against the anchor with viewport clamping (it flips
 * above / to the left near an edge, and becomes a bottom sheet on mobile).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AtSign, Building2, Copy, Check, ExternalLink, Loader2, Mail, Paperclip,
  Phone, Search, X,
} from "lucide-react";
import { getContactCard } from "../lib/api";
import { useEmailStore } from "../lib/emailStore";
import {
  ContactCard as ContactCardData,
  EmailAddress,
  SenderStatus,
} from "../lib/types";
import { initials, timeLabel } from "../lib/utils";

const CARD_WIDTH = 340;
/** Ceiling on the card's height; the real cap is whatever the viewport leaves
 *  below (or above) the anchor, so a full card scrolls instead of overflowing. */
const CARD_MAX_HEIGHT = 620;
const VIEWPORT_MARGIN = 8;
/** Below this the card can't sit beside anything — show it as a bottom sheet. */
const MOBILE_BREAKPOINT = 480;

/** Cards are re-opened constantly while reading a thread, and the answer barely
 *  moves. A short TTL keeps a re-open instant without ever showing stale mail
 *  for long. */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: ContactCardData }>();

function cacheKey(email: string, accountId?: string): string {
  return `${accountId ?? "*"}|${email.toLowerCase()}`;
}

async function loadCard(
  email: string,
  accountId?: string
): Promise<ContactCardData> {
  const key = cacheKey(email, accountId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await getContactCard(email, accountId);
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** Drop any cached card for this address — call after something changes what
 *  the card would say (a send, an unsubscribe). */
export function invalidateContactCard(email: string): void {
  const suffix = `|${email.toLowerCase()}`;
  for (const key of [...cache.keys()]) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
}

/** The Email Cleaner dispositions worth showing: the two that mean this
 *  person's future mail is being suppressed. APPROVED / UNHANDLED are the
 *  resting states and say nothing. */
function silencedLabel(status: SenderStatus): string | null {
  if (status === "UNSUBSCRIBED") return "Unsubscribed";
  if (status === "AUTO_ARCHIVED") return "Auto-archived";
  return null;
}

/** "3 days ago" / "in 2 months" — the card wants elapsed time, not a date. */
function relativeLabel(iso?: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.round((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

export interface ContactTriggerProps {
  contact: EmailAddress;
  /** Scope the card to one mailbox; omit to span every account. */
  accountId?: string;
  className?: string;
  title?: string;
  children: React.ReactNode;
}

/** Wrap a name/avatar to make it open the person's card. */
export function ContactTrigger({
  contact,
  accountId,
  className = "",
  title,
  children,
}: ContactTriggerProps) {
  // The anchor lives in state, not a ref: the popover needs the element to
  // measure against on its very first render, and a ref read during render is
  // never guaranteed to be populated yet.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const email = (contact?.email ?? "").trim();

  // Nothing to look up without an address — render the content inert rather
  // than offering a button that can only fail.
  if (!email) return <span className={className}>{children}</span>;

  return (
    <>
      <button
        type="button"
        title={title ?? `${contact.name || email} — contact details`}
        className={className}
        onClick={(e) => {
          // The trigger usually sits inside a clickable row (a thread header,
          // a list item); opening the card must not also activate the row.
          e.stopPropagation();
          e.preventDefault();
          const el = e.currentTarget;
          setAnchor((prev) => (prev ? null : el));
        }}
      >
        {children}
      </button>
      {anchor && (
        <ContactPopover
          anchor={anchor}
          contact={contact}
          accountId={accountId}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

/** A "To: a, b, c" line where every recipient opens their own card. */
export function RecipientList({
  label,
  people,
  accountId,
}: {
  label: string;
  people: EmailAddress[];
  accountId?: string;
}) {
  if (!people || people.length === 0) return null;
  return (
    <div className="text-xs text-muted-foreground">
      {label}:{" "}
      {people.map((p, i) => (
        <span key={`${p.email}-${i}`}>
          {i > 0 && ", "}
          <ContactTrigger
            contact={p}
            accountId={accountId}
            className="hover:text-primary hover:underline tech-transition"
          >
            {p.name || p.email}
          </ContactTrigger>
        </span>
      ))}
    </div>
  );
}

function ContactPopover({
  anchor,
  contact,
  accountId,
  onClose,
}: {
  anchor: HTMLElement | null;
  contact: EmailAddress;
  accountId?: string;
  onClose: () => void;
}) {
  const [card, setCard] = useState<ContactCardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pos, setPos] = useState<
    { top: number; left: number; maxHeight: number } | null
  >(null);
  const [sheet, setSheet] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const email = contact.email.trim();

  const openCompose = useEmailStore((s) => s.openCompose);
  const openEmailById = useEmailStore((s) => s.openEmailById);
  const setSearchFilters = useEmailStore((s) => s.setSearchFilters);
  const setSearchScope = useEmailStore((s) => s.setSearchScope);

  useEffect(() => {
    let alive = true;
    loadCard(email, accountId)
      .then((d) => alive && setCard(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [email, accountId]);

  // Position against the anchor once the card has a measurable size, flipping
  // and clamping so it always lands fully on screen. Placement can only be
  // computed AFTER a render (it measures the rendered card), so the state write
  // in the effect is the point of it, not an accident.
  useLayoutEffect(() => {
    const place = () => {
      if (window.innerWidth < MOBILE_BREAKPOINT) {
        setSheet(true);
        return;
      }
      setSheet(false);
      const rect = anchor?.getBoundingClientRect();
      // scrollHeight, not offsetHeight: the card is a scroll container, so its
      // rendered height is already clamped by the previous pass's maxHeight and
      // would make the card ratchet smaller on every re-place.
      const wanted = Math.min(cardRef.current?.scrollHeight || 320, CARD_MAX_HEIGHT);
      if (!rect) {
        setPos({
          top: Math.max(VIEWPORT_MARGIN, (window.innerHeight - wanted) / 2),
          left: Math.max(VIEWPORT_MARGIN, (window.innerWidth - CARD_WIDTH) / 2),
          maxHeight: Math.min(wanted, window.innerHeight - 2 * VIEWPORT_MARGIN),
        });
        return;
      }
      // Take whichever side of the anchor has more room, and let the card use
      // all of it — a people card that scrolls beats one that is cut off.
      const gap = 6;
      const roomBelow = window.innerHeight - rect.bottom - gap - VIEWPORT_MARGIN;
      const roomAbove = rect.top - gap - VIEWPORT_MARGIN;
      const below = roomBelow >= wanted || roomBelow >= roomAbove;
      const maxHeight = Math.max(160, Math.min(wanted, below ? roomBelow : roomAbove));
      setPos({
        top: below
          ? rect.bottom + gap
          : Math.max(VIEWPORT_MARGIN, rect.top - gap - maxHeight),
        left: Math.min(
          Math.max(VIEWPORT_MARGIN, rect.left),
          Math.max(VIEWPORT_MARGIN, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN)
        ),
        maxHeight,
      });
    };
    place();
    window.addEventListener("resize", place);
    // The reading pane scrolls under the card; re-anchor rather than drift.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, card]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyAddress = useCallback(() => {
    navigator.clipboard?.writeText(email).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined
    );
  }, [email]);

  const mailTo = useCallback(() => {
    openCompose({ to: email, subject: "" });
    onClose();
  }, [email, openCompose, onClose]);

  const searchTheirMail = useCallback(() => {
    // "All mail from this person" — everywhere, not just the open folder.
    setSearchScope("all");
    setSearchFilters([{ kind: "from", value: email }]);
    onClose();
  }, [email, setSearchScope, setSearchFilters, onClose]);

  const openMessage = useCallback(
    (id: string) => {
      void openEmailById(id);
      onClose();
    },
    [openEmailById, onClose]
  );

  // The popover only ever exists after a click, so there is no server render to
  // guard against — but bail defensively rather than portal into nothing.
  if (typeof document === "undefined") return null;

  const name = card?.name || contact.name || email;
  const details = card?.details;
  const subtitle = [details?.title, details?.organization]
    .filter(Boolean)
    .join(" · ");

  const body = (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Contact card for ${name}`}
      className={
        sheet
          ? "fixed inset-x-0 bottom-0 z-[91] rounded-t-2xl border-t border-border bg-popover shadow-2xl max-h-[88vh] overflow-y-auto pb-safe"
          : "fixed z-[91] rounded-xl border border-border bg-popover shadow-2xl overflow-y-auto"
      }
      style={
        sheet
          ? undefined
          : {
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width: CARD_WIDTH,
              maxHeight: pos?.maxHeight ?? CARD_MAX_HEIGHT,
            }
      }
      onClick={(e) => e.stopPropagation()}
    >
      {/* Identity */}
      <div className="flex items-start gap-3 p-4 pb-3">
        <div className="w-11 h-11 rounded-full bg-primary/20 text-primary flex items-center justify-center text-sm font-semibold shrink-0">
          {initials(name)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-foreground truncate">
            {name}
          </div>
          <button
            type="button"
            onClick={copyAddress}
            title="Copy address"
            className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-primary tech-transition max-w-full"
          >
            <span className="truncate">{email}</span>
            {copied ? (
              <Check size={11} className="shrink-0 text-success" />
            ) : (
              <Copy size={11} className="shrink-0 opacity-0 group-hover:opacity-100" />
            )}
          </button>
          {subtitle && (
            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
              {subtitle}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close contact card"
          className="p-1 rounded-lg text-muted-foreground hover:bg-secondary tech-transition shrink-0"
        >
          <X size={14} />
        </button>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-4 pb-3">
        <button
          type="button"
          onClick={mailTo}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 tech-transition"
        >
          <Mail size={12} /> Email
        </button>
        <button
          type="button"
          onClick={searchTheirMail}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition"
        >
          <Search size={12} /> All mail
        </button>
      </div>

      {error ? (
        <div className="px-4 pb-4 text-xs text-destructive">
          Couldn&apos;t load this contact — {error}
        </div>
      ) : !card ? (
        <div className="flex items-center gap-2 px-4 pb-4 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> Loading contact…
        </div>
      ) : (
        <>
          {/* Contact details — only what the person's own signature carried. */}
          {(details?.phones.length || details?.links.length || card.domain) && (
            <div className="border-t border-border px-4 py-3 space-y-1.5">
              {details?.phones.map((phone) => (
                <a
                  key={phone}
                  href={`tel:${phone.replace(/[^\d+]/g, "")}`}
                  className="flex items-center gap-2 text-xs text-foreground/85 hover:text-primary tech-transition"
                >
                  <Phone size={12} className="text-muted-foreground shrink-0" />
                  <span className="truncate">{phone}</span>
                </a>
              ))}
              {details?.organization && (
                <div className="flex items-center gap-2 text-xs text-foreground/85">
                  <Building2 size={12} className="text-muted-foreground shrink-0" />
                  <span className="truncate">{details.organization}</span>
                </div>
              )}
              {card.domain && !details?.organization && (
                <div className="flex items-center gap-2 text-xs text-foreground/85">
                  <AtSign size={12} className="text-muted-foreground shrink-0" />
                  <span className="truncate">{card.domain}</span>
                </div>
              )}
              {details?.links.map((link) => (
                <a
                  key={link}
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs text-primary hover:opacity-80 tech-transition"
                >
                  <ExternalLink size={12} className="shrink-0" />
                  <span className="truncate">{link.replace(/^https?:\/\//, "")}</span>
                </a>
              ))}
            </div>
          )}

          {/* Relationship — the numbers that say what this address IS. */}
          <div className="border-t border-border px-4 py-2.5 flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
            <span>
              <span className="text-foreground font-medium">
                {card.stats.received}
              </span>{" "}
              received
            </span>
            <span>
              <span className="text-foreground font-medium">{card.stats.sent}</span>{" "}
              sent
            </span>
            {card.stats.unread > 0 && (
              <span className="text-primary">{card.stats.unread} unread</span>
            )}
            {card.stats.lastSeen && (
              <span className="ml-auto">last {relativeLabel(card.stats.lastSeen)}</span>
            )}
          </div>

          {/* "Approved" is the Cleaner's resting state for anyone it has seen —
              a chip saying so on every colleague is noise. Only surface a
              disposition that changes what happens to their mail. */}
          {(card.category || silencedLabel(card.status)) && (
            <div className="px-4 pb-2.5 flex items-center gap-1.5 flex-wrap">
              {card.category && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                  {card.category}
                </span>
              )}
              {silencedLabel(card.status) && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-warning/15 text-warning">
                  {silencedLabel(card.status)}
                </span>
              )}
            </div>
          )}

          {/* Recent mail — small preview cards, newest first. */}
          <div className="border-t border-border px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
              Recent mail
            </div>
            {card.recent.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                No messages from this address yet.
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {card.recent.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => openMessage(m.id)}
                    className="text-left w-full rounded-lg border border-border bg-card px-2.5 py-2 hover:border-primary/40 hover:bg-secondary/30 tech-transition"
                  >
                    <div className="flex items-center gap-1.5">
                      {!m.isRead && (
                        <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                      )}
                      <span
                        className={`text-xs truncate flex-1 ${
                          m.isRead ? "text-foreground/85" : "text-foreground font-medium"
                        }`}
                      >
                        {m.subject}
                      </span>
                      {m.hasAttachments && (
                        <Paperclip size={10} className="text-muted-foreground shrink-0" />
                      )}
                      {m.receivedAt && (
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {timeLabel(m.receivedAt)}
                        </span>
                      )}
                    </div>
                    {m.preview && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                        {m.preview}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return createPortal(
    <>
      {/* Outside-click catcher, under the card. */}
      <div
        className={`fixed inset-0 z-[90] ${sheet ? "bg-black/40" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />
      {body}
    </>,
    document.body
  );
}
