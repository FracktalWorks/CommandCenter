import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // esbuild (used by /api/artifacts/compile to bundle React artifacts) ships a
  // native binary. Tracing it into the server bundle fails the build outright —
  // Next tries to parse the executable as source and dies on its non-UTF8 bytes.
  // Keeping it external makes the route `require` it at runtime instead.
  serverExternalPackages: ["esbuild"],
  images: {
    remotePatterns: [
      // Clearbit logo API — high-quality company logos
      { protocol: "https", hostname: "logo.clearbit.com" },
      // Google favicon service — universal fallback, works for every domain
      { protocol: "https", hostname: "www.google.com" },
      // DuckDuckGo favicon service — additional fallback
      { protocol: "https", hostname: "icons.duckduckgo.com" },
    ],
  },
};

export default nextConfig;
