"use client";

import ComingSoon from "@/components/ComingSoon";

export default function NotesPage() {
  return (
    <ComingSoon
      icon="N"
      title="Notes"
      subtitle="AI note taker"
      description="Capture ideas, meeting notes, and research with AI. Automatic tagging, linking, and summarisation keep your knowledge organised and searchable."
      returnTo="/chat"
    />
  );
}
