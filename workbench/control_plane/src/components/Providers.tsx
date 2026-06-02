"use client";

import { CopilotKitProvider, CopilotSidebar } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { SessionProvider } from "next-auth/react";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <CopilotKitProvider runtimeUrl="/api/copilot">
        {children}
        <CopilotSidebar
          defaultOpen={false}
          labels={{ modalHeaderTitle: "CommandCenter Copilot", welcomeMessageText: "What would you like to do?" }}
        />
      </CopilotKitProvider>
    </SessionProvider>
  );
}