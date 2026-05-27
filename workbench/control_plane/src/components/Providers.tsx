"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { SessionProvider } from "next-auth/react";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <CopilotKit runtimeUrl="/api/copilot">
        {children}
        <CopilotSidebar
          defaultOpen={false}
          instructions="You are the Jannet.AI operations copilot. You can read the currently-loaded skill, workflow, or observability context from the active pane. Cite skill IDs and entity IDs in [skill:...] / [deal:...] / [task:...] form when relevant."
          labels={{ title: "Jannet.AI Copilot", initial: "What would you like to do?" }}
        />
      </CopilotKit>
    </SessionProvider>
  );
}