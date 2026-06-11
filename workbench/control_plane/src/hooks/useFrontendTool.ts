"use client";

/**
 * useFrontendTool — register browser-side functions that agents can invoke.
 *
 * Pattern borrowed from CopilotKit's useFrontendTool. When an agent calls
 * a frontend tool, the handler runs in the user's browser with direct access
 * to React state, browser APIs, etc.  Results are returned to the agent.
 *
 * Usage:
 *   useFrontendTool({
 *     name: "setTheme",
 *     description: "Switch the UI theme",
 *     handler: async ({ theme }) => { document.documentElement.className = theme; },
 *   });
 */

import { useEffect, useRef } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

export interface FrontendToolDefinition {
  /** Unique tool name the agent will call. */
  name: string;
  /** Human-readable description for the agent. */
  description: string;
  /** Optional parameter schema (for documentation). */
  parameters?: Record<string, string>;
  /** The handler that executes in the browser. Returns a result string. */
  handler: (args: Record<string, unknown>) => Promise<string> | string;
}

// ── Global registry ────────────────────────────────────────────────────────

const _toolRegistry = new Map<string, FrontendToolDefinition>();

/** Register a frontend tool. Called by useFrontendTool on mount. */
export function registerFrontendTool(tool: FrontendToolDefinition): () => void {
  _toolRegistry.set(tool.name, tool);
  return () => {
    _toolRegistry.delete(tool.name);
  };
}

/** Get all registered frontend tools (for tool descriptions sent to agents). */
export function getRegisteredFrontendTools(): FrontendToolDefinition[] {
  return Array.from(_toolRegistry.values());
}

/** Execute a frontend tool by name. Returns the handler's result. */
export async function executeFrontendTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = _toolRegistry.get(name);
  if (!tool) throw new Error(`Frontend tool "${name}" not registered`);
  return tool.handler(args);
}

/** Build a tool descriptions block for injection into the agent's system prompt. */
export function buildFrontendToolsAddendum(): string {
  const tools = getRegisteredFrontendTools();
  if (!tools.length) return "";

  const lines = tools.map(
    (t) => `  - **${t.name}**: ${t.description}`,
  );

  return `
## Frontend Tools (browser-side)

The following tools run in the user's browser and can control the UI.
Call them when you need to interact with the user's interface:

${lines.join("\n")}
`;
}

// ── React hook ─────────────────────────────────────────────────────────────

/**
 * Register a frontend tool within a React component.
 * Automatically unregisters on unmount.
 */
export function useFrontendTool(tool: FrontendToolDefinition): void {
  const toolRef = useRef(tool);
  toolRef.current = tool;

  useEffect(() => {
    return registerFrontendTool(toolRef.current);
  }, []);
}
