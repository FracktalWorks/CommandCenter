"use client";

// WhatsApp Saved Replies — the founder's canned snippet library (W8). The answers
// typed ten times a day (price list, address, GST no.), with an optional
// '/shortcut'. Plain CRUD; the composer's picker inserts the body.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import {
  createSavedReply,
  deleteSavedReply,
  fetchAccounts,
  fetchSavedReplies,
} from "../../lib/api";
import type { WaSavedReply } from "../../lib/types";

export default function SavedRepliesPage() {
  const [loading, setLoading] = useState(true);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [replies, setReplies] = useState<WaSavedReply[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [shortcut, setShortcut] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const accs = await fetchAccounts();
      if (accs[0]?.id) setAccountId(accs[0].id);
      setLoading(false);
    })();
  }, []);

  const load = useCallback(async () => {
    if (accountId) setReplies(await fetchSavedReplies(accountId));
  }, [accountId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = useCallback(async () => {
    if (!accountId || !title.trim() || !body.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await createSavedReply({
      account_id: accountId,
      title: title.trim(),
      body: body.trim(),
      shortcut: shortcut.trim() || null,
    });
    setBusy(false);
    if (res.ok) {
      setTitle("");
      setBody("");
      setShortcut("");
      await load();
    } else {
      setError(res.error ?? "couldn't save");
    }
  }, [accountId, title, body, shortcut, busy, load]);

  const remove = useCallback(
    async (id: string) => {
      const res = await deleteSavedReply(id);
      if (res.ok) await load();
      else setError(res.error ?? "couldn't delete");
    },
    [load]
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6 text-foreground">
      <div className="mb-5 flex items-center gap-3">
        <Link
          href="/whatsapp"
          className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Queue
        </Link>
        <h1 className="text-[15px] font-semibold">Saved replies</h1>
        <span className="text-[11px] text-muted-foreground">
          canned snippets for the composer
        </span>
      </div>

      {error && (
        <div className="mb-3 rounded-md bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500">
          {error}
        </div>
      )}

      {/* add form */}
      <div className="mb-5 rounded-lg border border-border p-3">
        <div className="mb-2 flex gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. Price list)"
            className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] outline-none focus:border-primary"
          />
          <input
            value={shortcut}
            onChange={(e) => setShortcut(e.target.value)}
            placeholder="/shortcut (optional)"
            className="w-40 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] outline-none focus:border-primary"
          />
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder="The message to insert…"
          className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] outline-none focus:border-primary"
        />
        <div className="mt-2 flex justify-end">
          <button
            onClick={add}
            disabled={busy || !title.trim() || !body.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Add reply
          </button>
        </div>
      </div>

      {/* list */}
      {replies.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-center text-[13px] text-muted-foreground">
          No saved replies yet. Add the answers you send most.
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {replies.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold">{r.title}</span>
                  {r.shortcut && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {r.shortcut}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 whitespace-pre-wrap text-[11.5px] text-muted-foreground">
                  {r.body}
                </div>
              </div>
              <button
                onClick={() => remove(r.id)}
                className="mt-0.5 shrink-0 text-muted-foreground/60 hover:text-red-500"
                aria-label="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-[11px] text-muted-foreground/70">
        Saved replies are plain snippets you drop into the composer inside the
        24-hour window — different from Meta-approved templates, which are required
        once the window closes.
      </p>
    </div>
  );
}
