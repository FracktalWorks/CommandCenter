"use client";

import { CopilotKitProvider, CopilotSidebar, useFrontendTool } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { SessionProvider } from "next-auth/react";
import { z } from "zod";

/** Module-level stable references for the default empty props on
 *  `CopilotKitProvider`. Without these, the JS default `= {}` parameters
 *  produce a fresh object on every render, which causes the provider's
 *  internal `setRuntimeUrl / setHeaders / setAgents` effect to fire on every
 *  render, which recreates every remote agent (new instances, fresh
 *  `threadId`s, empty `messages` arrays). The net effect is that the chat
 *  appears to "lose" every message the moment a run finishes — the welcome
 *  screen stays forever even though the network round-trip succeeds. */
const STABLE_HEADERS: Record<string, string> = {};
const STABLE_PROPERTIES: Record<string, unknown> = {};
const STABLE_AGENTS: Record<string, never> = {};

/** Registers a frontend tool with the v2 CopilotKit client so the sidebar can
 *  answer graph-backed questions about ClickUp tasks, Zoho deals, people, etc. */
function BrainActions() {
  useFrontendTool({
    name: "queryCompanyData",
    description:
      "Query the Fracktal Works company brain — tasks, projects, deals, " +
      "contacts, and team activity from ClickUp and Zoho CRM. Use this " +
      "whenever the user asks about work, projects, status, open items, " +
      "deals, clients, or team members.",
    parameters: z.object({
      query: z
        .string()
        .describe("The natural-language question to answer from company data."),
    }),
    handler: async ({ query }) => {
      const res = await fetch("/api/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = (await res.json()) as {
        answer?: string;
        citations?: string[];
        error?: string;
      };
      if (!res.ok || data.error) {
        return `[graph error] ${data.error ?? res.status}`;
      }
      const citations = (data.citations ?? []).length
        ? `\n\nSources: ${(data.citations ?? []).join(", ")}`
        : "";
      return (data.answer ?? "") + citations;
    },
  });

  // -------- Write-back actions (Phase 0.5) ----------------------------
  // The model is instructed to ALWAYS quote the planned change in chat and
  // wait for the user's explicit "yes" before invoking these tools.

  useFrontendTool({
    name: "addClickUpComment",
    description:
      "Append a comment to a ClickUp task. Use the ClickUp task id (the " +
      "short slug ClickUp shows in the URL, NOT the internal UUID). Safe " +
      "to call without confirmation when the user explicitly asks you to " +
      "post a comment.",
    parameters: z.object({
      clickup_task_id: z
        .string()
        .describe("ClickUp task id, e.g. '86ab1cdef'."),
      comment_text: z
        .string()
        .describe("Comment body (markdown is rendered by ClickUp)."),
      notify_all: z
        .boolean()
        .optional()
        .describe("If true, notify every watcher. Default false."),
    }),
    handler: async ({ clickup_task_id, comment_text, notify_all }) => {
      const res = await fetch("/api/act/clickup/add-comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clickup_task_id,
          comment_text,
          notify_all: notify_all ?? false,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        summary?: string;
        error?: string;
      };
      if (!res.ok || data.error) return `[action error] ${data.error ?? res.status}`;
      return data.summary ?? (data.ok ? "Done." : "Failed.");
    },
  });

  useFrontendTool({
    name: "updateClickUpTaskStatus",
    description:
      "DESTRUCTIVE: change the status of a ClickUp task. You MUST first " +
      "show the user a one-line summary of the planned change (which task " +
      "and which new status) and wait for them to reply 'yes' / 'go ahead' " +
      "before calling this tool. Never call it on assumption.",
    parameters: z.object({
      clickup_task_id: z
        .string()
        .describe("ClickUp task id (slug shown in URL, not the UUID)."),
      status: z
        .string()
        .describe(
          "New status name as configured in the task's list, e.g. " +
            "'in progress', 'complete', 'backlog'."
        ),
      note: z
        .string()
        .optional()
        .describe("Optional free-text rationale; stored only in the audit log."),
    }),
    handler: async ({ clickup_task_id, status, note }) => {
      const res = await fetch("/api/act/clickup/update-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clickup_task_id, status, note }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        summary?: string;
        error?: string;
      };
      if (!res.ok || data.error) return `[action error] ${data.error ?? res.status}`;
      return data.summary ?? (data.ok ? "Done." : "Failed.");
    },
  });

  return null;
}

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <CopilotKitProvider
        runtimeUrl="/api/copilot"
        headers={STABLE_HEADERS}
        properties={STABLE_PROPERTIES}
        agents__unsafe_dev_only={STABLE_AGENTS}
        selfManagedAgents={STABLE_AGENTS}
      >
        <BrainActions />
        {children}
        <CopilotSidebar
          defaultOpen={false}
          labels={{ modalHeaderTitle: "Jannet.AI Copilot", welcomeMessageText: "What would you like to do?" }}
        />
      </CopilotKitProvider>
    </SessionProvider>
  );
}