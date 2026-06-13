"use client";

import ComingSoon from "@/components/ComingSoon";

export default function EmailPage() {
  return (
    <ComingSoon
      icon="E"
      title="Email"
      subtitle="AI-powered inbox"
      description="Read, compose, and manage email with AI assistance. Smart replies, summarisation, and automated follow-ups — all powered by CommandCenter."
      returnTo="/chat"
    />
  );
}
