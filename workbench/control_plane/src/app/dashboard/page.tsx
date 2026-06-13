"use client";

import ComingSoon from "@/components/ComingSoon";

export default function DashboardPage() {
  return (
    <ComingSoon
      icon="D"
      title="Dashboard"
      subtitle="Company overview"
      description="A real-time view of your company's key metrics, active agents, running tasks, and recent activity — all in one place."
      returnTo="/chat"
    />
  );
}
