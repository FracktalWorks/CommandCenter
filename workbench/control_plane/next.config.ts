import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
