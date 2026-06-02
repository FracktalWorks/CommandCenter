"use client";

import Link from "next/link";
import { useAgentContext } from "@copilotkit/react-core/v2";

export default function Workflows() {
  // Expose Workflow Editor context to the CopilotKit chat overlay
  useAgentContext({
    description: "Currently active pane in the CommandCenter Control Plane: Workflow Editor",
    value: {
      pane: "workflow-editor",
      tool: "langgraph",
      description: "LangGraph-powered workflow engine with React Flow canvas. Available in L3.",
    },
  });

  return (
    <div className="flex h-screen flex-col">
      <div className="border-b border-zinc-800 bg-zinc-900/60 px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Workflow Editor</h1>
            <p className="mt-1 text-sm text-zinc-400">
              LangGraph-powered workflow engine with React Flow canvas — available in L3.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/skills" className="text-sm text-blue-400 hover:underline">
              skills &rarr;
            </Link>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-sm text-zinc-500">
        <p className="text-lg font-medium text-zinc-300">Coming in L3</p>
        <p className="max-w-md text-center text-zinc-500">
          The visual workflow editor will be built on{" "}
          <span className="text-zinc-300">LangGraph</span> with a{" "}
          <span className="text-zinc-300">React Flow</span> canvas. Webhook and
          cron triggers, event-driven pipelines, and execution logs will all be
          managed by the LangGraph workflow engine.
        </p>
        <Link
          href="/skills"
          className="mt-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-zinc-300 hover:bg-zinc-700"
        >
          Go to Skill Studio
        </Link>
      </div>
    </div>
  );
}