"use client";

/**
 * useRenderTool — register custom React renderers for agent tool calls.
 *
 * Pattern borrowed from CopilotKit's useRenderTool / useDefaultRenderTool.
 * Components register renderers for specific tool names; when the agent
 * calls that tool, the registered component renders instead of the default
 * tool accordion.
 *
 * Usage:
 *   useRenderTool({
 *     name: "get_weather",
 *     render: ({ args, result, status }) => <WeatherCard location={args.location} />,
 *   });
 *
 *   // Catch-all for any tool without a specific renderer:
 *   useDefaultRenderTool({
 *     render: ({ name, args, result, status }) => <pre>{JSON.stringify(args)}</pre>,
 *   });
 */

import { useEffect, useRef, type ReactNode } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ToolRenderProps {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: "running" | "done" | "error";
}

export interface ToolRenderer {
  name: string;
  render: (props: ToolRenderProps) => ReactNode;
}

// ── Global registry ────────────────────────────────────────────────────────

const _rendererRegistry = new Map<string, ToolRenderer>();
let _defaultRenderer: ((props: ToolRenderProps) => ReactNode) | null = null;

/** Register a renderer for a specific tool name. */
export function registerToolRenderer(renderer: ToolRenderer): () => void {
  _rendererRegistry.set(renderer.name, renderer);
  return () => {
    _rendererRegistry.delete(renderer.name);
  };
}

/** Register a catch-all renderer for tools without a specific renderer. */
export function registerDefaultToolRenderer(
  render: (props: ToolRenderProps) => ReactNode,
): () => void {
  _defaultRenderer = render;
  return () => {
    _defaultRenderer = null;
  };
}

/** Get the renderer for a tool name (or the default renderer). */
export function getToolRenderer(name: string): ((props: ToolRenderProps) => ReactNode) | null {
  const specific = _rendererRegistry.get(name);
  if (specific) return specific.render;
  return _defaultRenderer;
}

// ── React hooks ────────────────────────────────────────────────────────────

export function useRenderTool(renderer: ToolRenderer): void {
  const ref = useRef(renderer);
  ref.current = renderer;
  useEffect(() => registerToolRenderer(ref.current), []);
}

export function useDefaultRenderTool(
  render: (props: ToolRenderProps) => ReactNode,
): void {
  const ref = useRef(render);
  ref.current = render;
  useEffect(() => registerDefaultToolRenderer((props) => ref.current(props)), []);
}
