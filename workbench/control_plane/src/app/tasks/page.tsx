"use client";

import ComingSoon from "@/components/ComingSoon";

export default function TasksPage() {
  return (
    <ComingSoon
      icon="T"
      title="Tasks"
      subtitle="AI task manager"
      description="Create, organise, and track tasks with AI. Smart prioritisation, deadline tracking, and automatic task breakdowns help you stay on top of everything."
      returnTo="/chat"
    />
  );
}
