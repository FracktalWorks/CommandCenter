"use client";

// WhatsApp Connect wizard (W11) — the guided, VERIFIABLE onboarding that turns
// Meta's fiddly Cloud API setup into four calm steps: what you need → point Meta
// at your inbox → paste + live-test your credentials → you're live. The "Test
// connection" step calls Meta's Graph API for real, so you never save a broken
// token. Honest by design: it names exactly what Meta requires and never fakes a
// one-click flow the platform can't actually deliver without app review.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  LogIn,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import {
  createAccount,
  embeddedSignup,
  fetchConnectionInfo,
  verifyConnection,
} from "../lib/api";
import type { WaConnectionInfo, WaVerifyResult } from "../lib/types";

const STEPS = ["Prerequisites", "Webhook", "Credentials", "Done"];

type ConnectMode = "loading" | "choose" | "manual" | "done";

export default function ConnectPage() {
  const router = useRouter();
  const [info, setInfo] = useState<WaConnectionInfo | null>(null);
  const [mode, setMode] = useState<ConnectMode>("loading");
  const [step, setStep] = useState(0);

  useEffect(() => {
    fetchConnectionInfo().then((i) => {
      setInfo(i);
      sessionStorage.setItem("wa_verify_token", i.verify_token);
      // One-click when the Meta app is Embedded-Signup-configured; else the
      // guided manual wizard.
      setMode(i.embedded_signup ? "choose" : "manual");
    });
  }, []);

  const goInbox = () => router.push("/whatsapp");

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col p-6">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-500">
          <MessageCircle className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-[16px] font-semibold leading-tight">
            Connect WhatsApp Business
          </h1>
          <p className="text-[12px] text-muted-foreground">
            Official Meta Cloud API · about 15 minutes
          </p>
        </div>
      </div>

      {mode === "loading" && (
        <div className="mt-10 flex justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}

      {mode === "choose" && info && (
        <ChooseConnect
          info={info}
          onManual={() => {
            setStep(0);
            setMode("manual");
          }}
          onDone={() => setMode("done")}
        />
      )}

      {mode === "manual" && (
        <>
          <Stepper step={step} />
          <div className="mt-6 flex-1">
            {step === 0 && (
              <StepPrereqs
                showOneClickHint={info?.embedded_signup === false}
                onNext={() => setStep(1)}
              />
            )}
            {step === 1 && (
              <StepWebhook
                info={info}
                onBack={() => setStep(0)}
                onNext={() => setStep(2)}
              />
            )}
            {step === 2 && (
              <StepCredentials
                onBack={() => setStep(1)}
                onConnected={() => setMode("done")}
              />
            )}
          </div>
        </>
      )}

      {mode === "done" && (
        <div className="mt-6">
          <StepDone onGo={goInbox} />
        </div>
      )}
    </div>
  );
}

// ── Chooser + Embedded Signup (W12) ───────────────────────────────────────────

type FbLoginResponse = { authResponse?: { code?: string } | null };
type FbWindow = Window & {
  FB?: {
    init: (opts: Record<string, unknown>) => void;
    login: (cb: (r: FbLoginResponse) => void, opts: Record<string, unknown>) => void;
  };
  fbAsyncInit?: () => void;
};

function ChooseConnect({
  info,
  onManual,
  onDone,
}: {
  info: WaConnectionInfo;
  onManual: () => void;
  onDone: () => void;
}) {
  return (
    <Card>
      <h2 className="text-[14px] font-semibold">Connect in one click</h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Log in with Facebook, pick your WhatsApp Business number, and you&apos;re
        done — no copy-pasting IDs or tokens. We finish the setup (token exchange
        and webhook subscription) for you.
      </p>
      <div className="mt-4">
        <EmbeddedSignupButton info={info} onDone={onDone} />
      </div>
      <div className="my-4 flex items-center gap-3 text-[10.5px] text-muted-foreground/70">
        <div className="h-px flex-1 bg-border" /> OR
        <div className="h-px flex-1 bg-border" />
      </div>
      <button
        onClick={onManual}
        className="w-full rounded-lg border border-border px-3 py-2 text-[12.5px] font-semibold text-muted-foreground hover:text-foreground"
      >
        Set up manually with my own credentials
      </button>
    </Card>
  );
}

function EmbeddedSignupButton({
  info,
  onDone,
}: {
  info: WaConnectionInfo;
  onDone: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionInfo = useRef<{ phone_number_id?: string; waba_id?: string }>({});

  // Load + init the Facebook JS SDK once.
  useEffect(() => {
    const w = window as unknown as FbWindow;
    const init = () => {
      if (!w.FB) return;
      w.FB.init({
        appId: info.fb_app_id,
        autoLogAppEvents: true,
        xfbml: true,
        version: info.graph_version,
      });
      setReady(true);
    };
    if (w.FB) {
      init();
      return;
    }
    w.fbAsyncInit = init;
    if (!document.getElementById("wa-fb-sdk")) {
      const s = document.createElement("script");
      s.id = "wa-fb-sdk";
      s.src = "https://connect.facebook.net/en_US/sdk.js";
      s.async = true;
      s.defer = true;
      s.crossOrigin = "anonymous";
      document.body.appendChild(s);
    }
  }, [info.fb_app_id, info.graph_version]);

  // Capture the WABA + phone number the user picks in the popup.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      try {
        if (!/facebook\.com$/.test(new URL(ev.origin).hostname)) return;
      } catch {
        return;
      }
      try {
        const data =
          typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        if (data?.type === "WA_EMBEDDED_SIGNUP" && data?.data) {
          sessionInfo.current = {
            phone_number_id: data.data.phone_number_id,
            waba_id: data.data.waba_id,
          };
        }
      } catch {
        /* not our message */
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const launch = useCallback(() => {
    const w = window as unknown as FbWindow;
    if (!w.FB || busy) return;
    setError(null);
    w.FB.login(
      (resp: FbLoginResponse) => {
        const code = resp?.authResponse?.code;
        const si = sessionInfo.current;
        if (!code || !si.phone_number_id) {
          setError("Signup was cancelled, or no number was selected.");
          return;
        }
        setBusy(true);
        embeddedSignup({
          code,
          phone_number_id: si.phone_number_id,
          waba_id: si.waba_id ?? null,
        }).then((res) => {
          setBusy(false);
          if (res.ok) onDone();
          else setError(res.error ?? "Couldn't finish connecting.");
        });
      },
      {
        config_id: info.es_config_id,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      }
    );
  }, [busy, info.es_config_id, onDone]);

  return (
    <div>
      <button
        onClick={launch}
        disabled={!ready || busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#1877F2] px-4 py-2.5 text-[13px] font-semibold text-white hover:opacity-95 disabled:opacity-60"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <LogIn className="h-4 w-4" />
        )}
        Continue with Facebook
      </button>
      {!ready && !error && (
        <p className="mt-2 text-center text-[10.5px] text-muted-foreground">
          Loading Facebook…
        </p>
      )}
      {error && (
        <div className="mt-2 rounded-md bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500">
          {error}
        </div>
      )}
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <div key={label} className="flex flex-1 items-center gap-2">
            <div className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${
                  done
                    ? "bg-emerald-500 text-white"
                    : active
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span
                className={`hidden text-[11px] sm:inline ${
                  active ? "font-semibold text-foreground" : "text-muted-foreground"
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`h-px flex-1 ${done ? "bg-emerald-500/50" : "bg-border"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: prerequisites ─────────────────────────────────────────────────────

function StepPrereqs({
  onNext,
  showOneClickHint,
}: {
  onNext: () => void;
  showOneClickHint?: boolean;
}) {
  const items = [
    {
      title: "A Meta app with WhatsApp",
      body: "Create one (or open yours) and add the WhatsApp product.",
      href: "https://developers.facebook.com/apps",
      link: "developers.facebook.com/apps",
    },
    {
      title: "Your Phone number ID + WhatsApp Business Account ID",
      body: "Both are on the WhatsApp → API Setup page of your app.",
      href: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
      link: "Cloud API · Get started",
    },
    {
      title: "A permanent access token",
      body: "Create a System User in Business Settings and generate a token with the whatsapp_business_messaging and whatsapp_business_management permissions.",
      href: "https://developers.facebook.com/docs/whatsapp/business-management-api/get-started",
      link: "System user tokens",
    },
  ];
  return (
    <Card>
      <h2 className="text-[14px] font-semibold">Before you start</h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        You&apos;ll set up three things in Meta&apos;s dashboard, then paste them
        here. We&apos;ll test them against Meta before saving, so you never store a
        broken token.
      </p>
      {showOneClickHint && (
        <div className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          Tip: set <code>WHATSAPP_APP_ID</code> and{" "}
          <code>WHATSAPP_ES_CONFIG_ID</code> on the server to unlock the one-click
          &ldquo;Continue with Facebook&rdquo; flow instead of this manual setup.
        </div>
      )}
      <ol className="mt-4 space-y-3">
        {items.map((it, i) => (
          <li key={it.title} className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-[12.5px] font-semibold">{it.title}</div>
              <div className="text-[11.5px] text-muted-foreground">{it.body}</div>
              <a
                href={it.href}
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-emerald-600 hover:underline"
              >
                {it.link} <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex justify-end">
        <PrimaryButton onClick={onNext}>
          Continue <ArrowRight className="h-3.5 w-3.5" />
        </PrimaryButton>
      </div>
    </Card>
  );
}

// ── Step 2: webhook ───────────────────────────────────────────────────────────

function StepWebhook({
  info,
  onBack,
  onNext,
}: {
  info: WaConnectionInfo | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const [domain, setDomain] = useState("");

  const webhookUrl =
    info?.base_configured && info.webhook_url
      ? info.webhook_url
      : domain
        ? `${domain.replace(/\/+$/, "")}/whatsapp/webhook`
        : "";

  return (
    <Card>
      <h2 className="text-[14px] font-semibold">Point Meta at your inbox</h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        In Meta → WhatsApp → Configuration, set the webhook below, click{" "}
        <b>Verify and save</b>, then subscribe to the <code>messages</code> field.
      </p>

      {!info ? (
        <div className="mt-4 flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {!info.base_configured && (
            <Field label="Your public gateway URL">
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="https://your-domain.com"
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] outline-none focus:border-primary"
              />
              <p className="mt-1 text-[10.5px] text-muted-foreground">
                The public HTTPS address of this CommandCenter gateway. (Set
                <code className="mx-1">WHATSAPP_PUBLIC_URL</code>on the server to
                skip this.)
              </p>
            </Field>
          )}
          <CopyRow label="Callback URL" value={webhookUrl} />
          <CopyRow label="Verify token" value={info.verify_token} />
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <GhostButton onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </GhostButton>
        <PrimaryButton onClick={onNext} disabled={!webhookUrl}>
          I&apos;ve done this <ArrowRight className="h-3.5 w-3.5" />
        </PrimaryButton>
      </div>
    </Card>
  );
}

// ── Step 3: credentials + live test ───────────────────────────────────────────

function StepCredentials({
  onBack,
  onConnected,
}: {
  onBack: () => void;
  onConnected: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneId, setPhoneId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<WaVerifyResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canTest = phoneId.trim() && token.trim();
  const verified = result?.ok === true;

  const doTest = useCallback(async () => {
    if (!canTest || testing) return;
    setTesting(true);
    setResult(null);
    setError(null);
    const res = await verifyConnection({
      phone_number_id: phoneId.trim(),
      access_token: token.trim(),
    });
    setTesting(false);
    if (res.ok && res.data) {
      setResult(res.data);
      if (res.data.ok && res.data.display_phone_number && !phone)
        setPhone(res.data.display_phone_number);
    } else {
      setError(res.error ?? "Couldn't reach the server.");
    }
  }, [canTest, testing, phoneId, token, phone]);

  const doConnect = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const res = await createAccount({
      phone_number: (phone || result?.display_phone_number || "").trim(),
      phone_number_id: phoneId.trim(),
      waba_id: wabaId.trim() || null,
      display_name: displayName.trim() || result?.verified_name || "",
      webhook_verify_token: sessionStorage.getItem("wa_verify_token"),
      credentials: { access_token: token.trim() },
    });
    setSaving(false);
    if (res.ok) onConnected();
    else setError(res.error ?? "Couldn't connect the number.");
  }, [saving, phone, result, phoneId, wabaId, displayName, token, onConnected]);

  return (
    <Card>
      <h2 className="text-[14px] font-semibold">Enter your credentials</h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Paste these from the WhatsApp → API Setup page. Nothing is saved until you
        test and connect; the token is encrypted at rest.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Phone number ID *">
          <TextInput value={phoneId} onChange={setPhoneId} placeholder="1029384756…" />
        </Field>
        <Field label="Business account ID (WABA)">
          <TextInput value={wabaId} onChange={setWabaId} placeholder="optional" />
        </Field>
        <Field label="Display name">
          <TextInput
            value={displayName}
            onChange={setDisplayName}
            placeholder="e.g. Fracktal Works"
          />
        </Field>
        <Field label="Phone number">
          <TextInput value={phone} onChange={setPhone} placeholder="+91…" />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Permanent access token *">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="EAAG…"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-primary"
          />
        </Field>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <GhostButton onClick={doTest} disabled={!canTest || testing}>
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          Test connection
        </GhostButton>
        {verified && (
          <span className="text-[11px] font-semibold text-emerald-600">
            Verified with Meta
          </span>
        )}
      </div>

      {result?.ok && (
        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-emerald-600">
            <CheckCircle2 className="h-4 w-4" />
            {result.verified_name || "Connected"}
          </div>
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">
            {result.display_phone_number}
            {result.quality_rating && (
              <> · quality {result.quality_rating.toLowerCase()}</>
            )}
          </div>
        </div>
      )}
      {result && !result.ok && (
        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[11.5px] text-red-500">
          {result.error}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-md bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500">
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <GhostButton onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </GhostButton>
        <PrimaryButton onClick={doConnect} disabled={!verified || saving}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Connect number
        </PrimaryButton>
      </div>
      {!verified && (
        <p className="mt-2 text-right text-[10.5px] text-muted-foreground">
          Test the connection first, so a broken token is never saved.
        </p>
      )}
    </Card>
  );
}

// ── Step 4: done ──────────────────────────────────────────────────────────────

function StepDone({ onGo }: { onGo: () => void }) {
  return (
    <Card>
      <div className="flex flex-col items-center py-4 text-center">
        <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-500">
          <CheckCircle2 className="h-7 w-7" />
        </span>
        <h2 className="text-[15px] font-semibold">You&apos;re connected 🎉</h2>
        <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] text-muted-foreground">
          New messages will land in your triage queue as they arrive. Older chats
          aren&apos;t imported yet — coexistence history sync comes later — so your
          inbox starts fresh from now.
        </p>
        <PrimaryButton onClick={onGo} className="mt-5">
          Go to inbox <ArrowRight className="h-3.5 w-3.5" />
        </PrimaryButton>
      </div>
    </Card>
  );
}

// ── shared bits ───────────────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-background p-5">
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] outline-none focus:border-primary"
    />
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the value is still selectable */
    }
  }, [value]);
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate text-[11.5px]">
          {value || "—"}
        </code>
        <button
          onClick={copy}
          disabled={!value}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10.5px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-500" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

function GhostButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}
