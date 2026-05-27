import type { NextConfig } from "next";

const n8nBase = process.env.N8N_BASE_URL ?? "http://127.0.0.1:5678";

const nextConfig: NextConfig = {
  // Proxy all n8n traffic through the Next.js dev server so the iframe is
  // same-origin (no cross-port ERR_CONNECTION_REFUSED / PNA blocking in the
  // browser). n8n is configured with N8N_PATH=/n8n/ so its SPA entry and Vue
  // Router paths live at /n8n/. However, n8n's Vite build hardcodes /assets/
  // and /static/ for all JS/CSS chunks (built-in absolute paths), so we must
  // also proxy those bare paths in addition to the /n8n/-prefixed ones.
  async rewrites() {
    return [
      // ── /n8n/-prefixed paths ──────────────────────────────────────────────
      // Static asset bundles — strip the /n8n/ prefix (n8n serves them at /)
      { source: "/n8n/assets/:path*", destination: `${n8nBase}/assets/:path*` },
      { source: "/n8n/static/:path*", destination: `${n8nBase}/static/:path*` },
      // n8n REST API — strip the /n8n/ prefix
      { source: "/n8n/rest/:path*", destination: `${n8nBase}/rest/:path*` },
      { source: "/n8n/types/:path*", destination: `${n8nBase}/types/:path*` },
      { source: "/n8n/webhook/:path*", destination: `${n8nBase}/webhook/:path*` },
      { source: "/n8n/webhook-waiting/:path*", destination: `${n8nBase}/webhook-waiting/:path*` },
      { source: "/n8n/form/:path*", destination: `${n8nBase}/form/:path*` },
      // Favicon
      { source: "/n8n/favicon.ico", destination: `${n8nBase}/favicon.ico` },
      // n8n SPA entry + Vue Router paths (keep /n8n/ prefix — n8n handles them)
      { source: "/n8n", destination: `${n8nBase}/n8n` },
      { source: "/n8n/", destination: `${n8nBase}/n8n/` },
      { source: "/n8n/:path*", destination: `${n8nBase}/n8n/:path*` },

      // ── Bare asset paths (Vite-built JS/CSS lazy chunks) ──────────────────
      // n8n's compiled JS uses absolute /assets/ paths for dynamic imports;
      // these must be rewritten even without the /n8n/ prefix.
      { source: "/assets/:path*", destination: `${n8nBase}/assets/:path*` },
      { source: "/static/:path*", destination: `${n8nBase}/static/:path*` },
    ];
  },
};

export default nextConfig;
