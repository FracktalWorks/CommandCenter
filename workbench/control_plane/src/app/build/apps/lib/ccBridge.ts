"use client";

/**
 * ccBridge — the Custom Apps capability bridge (Phase 0: user / storage / ai).
 *
 * Two halves that speak one tiny RPC protocol over postMessage:
 *
 *  1. buildAppSrcDoc()  — injects a dependency-free `window.cc` SDK script into
 *     an app bundle before it is handed to <SandboxedHtml>. Inside the frame,
 *     every cc.* method posts `{ __ccsdk: true, id, method, args }` to the
 *     parent and awaits the matching `{ __ccsdk: true, id, result | error }`
 *     reply (30 s timeout).
 *  2. useCcBridge()     — the parent-side listener that validates each request,
 *     executes it against the App Runtime API (/api/apps/{slug}/…) with the
 *     VIEWER's session, and posts the reply back to the frame.
 *
 * The `__ccsdk` namespace flag is deliberately distinct from SandboxedHtml's
 * internal `__cc` flag (ccAction/ccSubmit/height) so the two protocols coexist
 * on the same window without ever colliding: each handler ignores the other's
 * messages.
 *
 * Besides the RPC calls, the SDK also mirrors frame errors (window.onerror,
 * unhandledrejection, console.error) to the parent as fire-and-forget
 * `{ __ccsdk, event: "console", … }` notifications — no `id`, so the RPC
 * broker ignores them; `useCcBridge({ onConsoleEvent })` surfaces them to
 * the Workshop's console drawer.
 *
 * Trust model: the frame holds no token, no cookie, no credential — every call
 * is brokered by this page and executed as the viewing user (see RFC §4.4).
 */

import { useEffect, useRef } from "react";

// ─── In-frame SDK ─────────────────────────────────────────────────────────

/** Escape a value for safe embedding inside a <script> string literal. */
function safeScriptJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The `window.cc` SDK injected into every app frame (preview AND published,
 * so behaviour is identical in both — no "works in preview, breaks live").
 * Dependency-free, promise-based, ~80 lines. `__SLUG__` / `__MODE__` are
 * replaced with JSON literals at build time.
 */
const CC_SDK = `
<script>
  (function () {
    var SLUG = __SLUG__;
    var MODE = __MODE__;
    var TIMEOUT_MS = 30000;
    var seq = 0;
    var pending = {};
    // Every cc.* method funnels here: post the request to the parent page and
    // await the matching reply by id. The parent brokers the actual API call.
    function call(method, args) {
      return new Promise(function (resolve, reject) {
        var id = "cc-" + MODE + "-" + (++seq) + "-" + Date.now();
        var timer = setTimeout(function () {
          delete pending[id];
          reject(new Error("cc." + method + " timed out after 30s"));
        }, TIMEOUT_MS);
        pending[id] = { resolve: resolve, reject: reject, timer: timer };
        try {
          parent.postMessage(
            { __ccsdk: true, id: id, method: method, args: args || [], slug: SLUG, mode: MODE },
            "*"
          );
        } catch (e) {
          clearTimeout(timer);
          delete pending[id];
          reject(e);
        }
      });
    }
    window.addEventListener("message", function (ev) {
      var d = ev.data;
      if (!d || typeof d !== "object" || d.__ccsdk !== true || !d.id) return;
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      clearTimeout(p.timer);
      if (d.error != null) p.reject(new Error(String(d.error)));
      else p.resolve(d.result);
    });
    // ── Console capture ──────────────────────────────────────────────
    // window.onerror / unhandledrejection / console.error are mirrored to
    // the parent as fire-and-forget notifications (event field, NO id — the
    // parent's RPC broker ignores them; its console listener picks them up).
    var CONSOLE_CAP = 2000;
    var lastConsoleKey = null;
    function postConsole(level, message, stack) {
      try {
        var msg = String(message == null ? "" : message).slice(0, CONSOLE_CAP);
        var stk = stack == null ? null : String(stack).slice(0, CONSOLE_CAP);
        // Dedupe identical consecutive messages (error loops spam otherwise).
        var key = level + "\\u0000" + msg + "\\u0000" + (stk || "");
        if (key === lastConsoleKey) return;
        lastConsoleKey = key;
        var payload = {
          __ccsdk: true,
          event: "console",
          level: level,
          message: msg,
          slug: SLUG,
          mode: MODE
        };
        if (stk) payload.stack = stk;
        parent.postMessage(payload, "*");
      } catch (e) {
        /* fire-and-forget */
      }
    }
    var prevOnError = window.onerror;
    window.onerror = function (message, source, lineno, colno, error) {
      postConsole("error", message, error && error.stack);
      if (typeof prevOnError === "function") {
        return prevOnError.apply(this, arguments);
      }
      return false;
    };
    window.addEventListener("unhandledrejection", function (ev) {
      var r = ev && ev.reason;
      if (r instanceof Error) {
        postConsole("error", "Unhandled rejection: " + r.message, r.stack);
      } else {
        var text;
        try { text = typeof r === "string" ? r : JSON.stringify(r); }
        catch (e) { text = String(r); }
        postConsole("error", "Unhandled rejection: " + text, null);
      }
    });
    var origConsoleError = console.error;
    console.error = function () {
      try { origConsoleError.apply(console, arguments); } catch (e) {}
      var parts = [];
      var stack = null;
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        if (a instanceof Error) {
          parts.push(a.message);
          if (!stack && a.stack) stack = a.stack;
        } else if (typeof a === "object" && a !== null) {
          try { parts.push(JSON.stringify(a)); }
          catch (e) { parts.push(String(a)); }
        } else {
          parts.push(String(a));
        }
      }
      postConsole("error", parts.join(" "), stack);
    };
    function table(name) {
      return {
        list: function (opts) { return call("storage.list", [name, opts || {}]); },
        get: function (key) { return call("storage.get", [name, key]); },
        set: function (key, value, opts) { return call("storage.set", [name, key, value, opts || {}]); },
        "delete": function (key) { return call("storage.delete", [name, key]); }
      };
    }
    window.cc = {
      user: function () { return call("user.me", []); },
      storage: { table: table, kv: table("kv") },
      ai: {
        complete: function (prompt, opts) { return call("ai.complete", [prompt, opts || {}]); }
      }
    };
  })();
</script>`;

export interface BuildAppSrcDocOpts {
  slug: string;
  mode: "draft" | "live";
}

/**
 * Prepend the `window.cc` SDK to an app bundle so it is defined before any
 * app code runs. Injected right after <head> when present, else prepended.
 * The result is fed to <SandboxedHtml> (which supplies the sandbox + CSP).
 */
export function buildAppSrcDoc(
  bundleHtml: string,
  opts: BuildAppSrcDocOpts
): string {
  const sdk = CC_SDK.replace("__SLUG__", safeScriptJson(opts.slug)).replace(
    "__MODE__",
    safeScriptJson(opts.mode)
  );
  // (\s[^>]*)? — match <head> / <head lang…> but never <header>.
  const headMatch = /<head(\s[^>]*)?>/i.exec(bundleHtml);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return bundleHtml.slice(0, at) + sdk + bundleHtml.slice(at);
  }
  return sdk + bundleHtml;
}

// ─── Parent-side broker ───────────────────────────────────────────────────

interface CcSdkRequest {
  __ccsdk: true;
  id: string;
  method: string;
  args: unknown[];
  slug?: string;
  mode?: string;
}

function isCcSdkRequest(data: unknown): data is CcSdkRequest {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.__ccsdk === true &&
    typeof d.id === "string" &&
    typeof d.method === "string" &&
    Array.isArray(d.args)
  );
}

/** A console notification surfaced to the page (Workshop console drawer). */
export interface CcConsoleEvent {
  level: string;
  message: string;
  stack?: string;
}

/** Fire-and-forget console notification from the frame (event, NO id). */
interface CcConsoleMessage extends CcConsoleEvent {
  __ccsdk: true;
  event: "console";
  slug?: string;
  mode?: string;
}

function isCcConsoleMessage(data: unknown): data is CcConsoleMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.__ccsdk === true &&
    d.event === "console" &&
    typeof d.level === "string" &&
    typeof d.message === "string" &&
    (d.stack === undefined || typeof d.stack === "string")
  );
}

/** Read an app-supplied path segment (table / key), rejecting non-strings. */
function seg(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) {
    throw new Error(`invalid ${what}`);
  }
  return encodeURIComponent(v);
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(err);
  }
  return body;
}

/** Execute one SDK request against the App Runtime API (viewer's session). */
async function dispatch(slug: string, msg: CcSdkRequest): Promise<unknown> {
  const base = `/api/apps/${encodeURIComponent(slug)}`;
  const [a0, a1, a2, a3] = msg.args;
  switch (msg.method) {
    case "user.me": {
      return jsonOrThrow(await fetch(`${base}/me`));
    }
    case "storage.list": {
      const table = seg(a0, "table");
      const opts = (a1 ?? {}) as { scope?: string };
      const qs = opts.scope === "user" ? "?scope=user" : "";
      const body = (await jsonOrThrow(
        await fetch(`${base}/data/${table}${qs}`)
      )) as { rows?: unknown[] };
      return body?.rows ?? body;
    }
    case "storage.get": {
      const table = seg(a0, "table");
      const key = seg(a1, "key");
      const res = await fetch(`${base}/data/${table}/${key}`);
      if (res.status === 404) return null;
      const row = await jsonOrThrow(res);
      // Row shape is {key, value, …} — resolve with the stored value.
      if (row && typeof row === "object" && "value" in row) {
        return (row as { value: unknown }).value;
      }
      return row;
    }
    case "storage.set": {
      const table = seg(a0, "table");
      const key = seg(a1, "key");
      const opts = (a3 ?? {}) as { scope?: string };
      await jsonOrThrow(
        await fetch(`${base}/data/${table}/${key}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            value: a2,
            ...(opts.scope ? { scope: opts.scope } : {}),
          }),
        })
      );
      return true;
    }
    case "storage.delete": {
      const table = seg(a0, "table");
      const key = seg(a1, "key");
      const res = await fetch(`${base}/data/${table}/${key}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      return true;
    }
    case "ai.complete": {
      const opts = (a1 ?? {}) as Record<string, unknown>;
      const payload =
        Array.isArray(a0) ? { messages: a0, ...opts } : { prompt: a0, ...opts };
      // 429 {error:"ai_budget_exhausted"} surfaces as a rejection the app can
      // catch and render.
      return jsonOrThrow(
        await fetch(`${base}/ai/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      );
    }
    default:
      throw new Error(`unknown method: ${msg.method}`);
  }
}

/**
 * Install the parent-side `window.cc` broker for an app frame on this page.
 * Listens for `__ccsdk` requests, executes them against /api/apps/{slug}/…,
 * and posts the reply back to the requesting frame. Cleans up on unmount.
 */
export function useCcBridge(
  slug: string,
  opts?: {
    mode?: "draft" | "live";
    /** Invoked for `event: "console"` notifications from the app frame. */
    onConsoleEvent?: (e: CcConsoleEvent) => void;
  }
): void {
  const mode = opts?.mode ?? "live";
  // Ref'd so a new callback identity never tears down the listener.
  const onConsoleEventRef = useRef(opts?.onConsoleEvent);
  useEffect(() => {
    onConsoleEventRef.current = opts?.onConsoleEvent;
  });
  useEffect(() => {
    let disposed = false;

    function onMessage(ev: MessageEvent) {
      const data: unknown = ev.data;
      // Console notifications (no id) are not RPC — surface and stop.
      if (isCcConsoleMessage(data)) {
        if (data.slug !== slug) return;
        onConsoleEventRef.current?.({
          level: data.level,
          message: data.message,
          ...(data.stack !== undefined ? { stack: data.stack } : {}),
        });
        return;
      }
      if (!isCcSdkRequest(data)) return;
      // Ignore requests stamped for a different app (two frames on one page).
      if (data.slug && data.slug !== slug) return;
      const source = ev.source;
      if (!source) return;

      // targetOrigin "*" is acceptable (and required) here: the app frame is a
      // sandboxed srcDoc WITHOUT allow-same-origin, so it has an opaque origin
      // ("null") that cannot be named as a targetOrigin. The reply still goes
      // only to that specific window (ev.source), which we captured above.
      const reply = (payload: { result?: unknown; error?: string }) => {
        try {
          (source as Window).postMessage(
            { __ccsdk: true, id: data.id, ...payload },
            "*"
          );
        } catch {
          // Frame may have been torn down — nothing to do.
        }
      };

      dispatch(slug, data)
        .then((result) => {
          if (!disposed) reply({ result: result ?? null });
        })
        .catch((err: unknown) => {
          if (!disposed)
            reply({ error: err instanceof Error ? err.message : String(err) });
        });
    }

    window.addEventListener("message", onMessage);
    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
    };
  }, [slug, mode]);
}
