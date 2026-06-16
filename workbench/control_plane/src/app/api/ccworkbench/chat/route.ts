/**
 * POST /api/ccworkbench/chat
 *
 * Standalone GitHub Copilot SDK chat endpoint for CC Workbench.
 * Calls api.githubcopilot.com directly using GITHUB_TOKEN — no dependency
 * on the CC gateway, MAF, or Postgres.
 *
 * Implements a tool-calling loop:
 *   1. Non-streaming call with tool definitions (read_file, git_status, etc.)
 *   2. If finish_reason == "tool_calls" → execute tools server-side, loop
 *   3. When finish_reason == "stop" → stream final text as SSE delta events
 *
 * SSE event types (same format as /api/agent/chat for UI compatibility):
 *   {"type":"tool_start", "id":"…","name":"…","args":{}}
 *   {"type":"tool_end",   "id":"…","name":"…","result":"…","success":bool}
 *   {"type":"delta",      "content":"…"}
 *   {"type":"done"}
 *   {"type":"error",      "content":"…"}
 *
 * LLM routing:
 *   All model calls go through the CC gateway LiteLLM endpoint
 *   (COPILOT_LLM_BASE_URL, default port 8080). This gives access to every
 *   provider configured in CC — Copilot, DeepSeek, Groq, OpenRouter, Gemini, etc.
 *   The gateway never needs to be running to use the tools; it only needs to be
 *   reachable for the LLM call itself.
 *
 * Env vars:
 *   COPILOT_LLM_BASE_URL   — CC gateway LiteLLM base URL (default http://127.0.0.1:8080/v1)
 *   GATEWAY_INTERNAL_TOKEN — auth token for the gateway (default sk-local-dev-change-me)
 *   CCWORKBENCH_REPO_PATH  — absolute path to the CC repo (defaults to process.cwd())
 */

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { exec } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { auth } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

// ── Config ───────────────────────────────────────────────────────────────────

const GATEWAY_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";
const LITELLM_BASE_URL =
  process.env.COPILOT_LLM_BASE_URL ??
  process.env.LITELLM_BASE_URL ??
  "http://127.0.0.1:8080/v1";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

// Resolve repo path at module load. Using a statically-scoped default avoids
// Turbopack tracing the entire project tree during build.
const _default = path.join(
  /*turbopackIgnore: true*/ process.cwd(),
  "../..",
);
const REPO_PATH = path.resolve(process.env.CCWORKBENCH_REPO_PATH ?? _default);

/**
 * Primary: CC gateway LiteLLM (all configured providers).
 * Fallback: direct GitHub Copilot API — works even when the CC gateway is down.
 */
function makeGatewayClient(): OpenAI {
  return new OpenAI({ apiKey: GATEWAY_TOKEN, baseURL: LITELLM_BASE_URL });
}

function makeCopilotDirectClient(): OpenAI {
  return new OpenAI({
    apiKey: GITHUB_TOKEN,
    baseURL: "https://api.githubcopilot.com",
    defaultHeaders: {
      "Editor-Version": "vscode/1.100.0",
      "Copilot-Integration-Id": "vscode-chat",
    },
  });
}

/** Probe if the CC gateway LiteLLM endpoint is reachable (2.5 s timeout). */
async function isGatewayReachable(): Promise<boolean> {
  try {
    const url = LITELLM_BASE_URL.replace(/\/v1\/?$/, "/health");
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(2_500),
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
    });
    return resp.ok || resp.status === 401;
  } catch {
    return false;
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the CommandCenter repository. Returns up to 8 KB of content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the repo root." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List entries in a directory inside the CommandCenter repository.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relative to the repo root. Defaults to the repo root.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Run `git status` in the CommandCenter repository.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Run `git diff` in the CommandCenter repository, optionally for a specific file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional: relative file path to diff." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description:
        "Run pytest in the CommandCenter repository. Times out after 120 s. Returns stdout+stderr.",
      parameters: {
        type: "object",
        properties: {
          test_path: {
            type: "string",
            description: "Optional: specific test file or directory (default: tests/).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_logs",
      description:
        "Tail logs from a CommandCenter Docker container. Falls back to journalctl on the VPS.",
      parameters: {
        type: "object",
        properties: {
          service: {
            type: "string",
            enum: ["gateway", "postgres", "redis", "neo4j", "workbench"],
            description: "Service name.",
          },
          lines: {
            type: "number",
            description: "Number of tail lines to return (default: 50).",
          },
        },
        required: ["service"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trigger_deploy",
      description:
        "Trigger a deployment of CommandCenter to the VPS by executing deploy/hostinger/deploy.sh. Use only when the user explicitly asks to deploy.",
      parameters: {
        type: "object",
        properties: {
          branch: { type: "string", description: "Git branch to deploy (default: main)." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write or overwrite a file in the CommandCenter repository. Use for creating new files or applying edits. Always read_file first to understand existing content before overwriting.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the repo root." },
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description:
        "Search for a pattern across the CommandCenter codebase using grep. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex supported)." },
          path: { type: "string", description: "Optional: subdirectory to search within (default: whole repo)." },
          file_pattern: { type: "string", description: "Optional: glob for file types, e.g. '*.py' or '*.ts'." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description:
        "Stage files and create a git commit. Defaults to staging all changes (git add -A).",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message." },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Optional: specific relative paths to stage. Defaults to all changes.",
          },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run an arbitrary shell command in the CommandCenter repo root. Use for linting, type-checking, formatting, installing deps, etc. Times out after 60 s.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
        },
        required: ["command"],
      },
    },
  },
];

// ── Tool executor ────────────────────────────────────────────────────────────

/** Resolve a user-supplied relative path safely within REPO_PATH. */
function safeResolve(rel: string): string | null {
  const resolved = path.resolve(REPO_PATH, rel);
  return resolved.startsWith(REPO_PATH) ? resolved : null;
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "read_file": {
      const target = safeResolve(String(args.path ?? ""));
      if (!target) return "Error: path is outside the repository";
      try {
        const content = await fs.readFile(target, "utf-8");
        return content.slice(0, 8000);
      } catch (e) {
        return `Error reading file: ${e}`;
      }
    }

    case "list_directory": {
      const rel = String(args.path ?? ".");
      const target = safeResolve(rel);
      if (!target) return "Error: path is outside the repository";
      try {
        const entries = await fs.readdir(target, { withFileTypes: true });
        return entries
          .map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`)
          .join("\n");
      } catch (e) {
        return `Error listing directory: ${e}`;
      }
    }

    case "git_status": {
      try {
        const { stdout } = await execAsync("git status", { cwd: REPO_PATH });
        return stdout;
      } catch (e: unknown) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    case "git_diff": {
      const filePart = args.path ? ` -- "${path.resolve(REPO_PATH, String(args.path))}"` : "";
      try {
        const { stdout } = await execAsync(`git diff${filePart}`, { cwd: REPO_PATH });
        return stdout.slice(0, 10000) || "(no uncommitted changes)";
      } catch (e: unknown) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    case "run_tests": {
      const testPath = String(args.test_path ?? "tests/");
      // Validate the path is inside the repo before running
      const resolved = safeResolve(testPath);
      if (!resolved) return "Error: test path is outside the repository";
      try {
        const { stdout, stderr } = await execAsync(
          `uv run python -m pytest "${resolved}" -x -v --tb=short 2>&1`,
          { cwd: REPO_PATH, timeout: 120_000 },
        );
        return (stdout + stderr).slice(0, 10_000);
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return ((err.stdout ?? "") + (err.stderr ?? "") || err.message || String(e)).slice(0, 10_000);
      }
    }

    case "view_logs": {
      const service = String(args.service ?? "gateway");
      const lines = Number(args.lines ?? 50);
      const containerMap: Record<string, string> = {
        gateway: "acb-gateway",
        postgres: "acb-postgres",
        redis: "acb-redis",
        neo4j: "acb-neo4j",
        workbench: "acb-workbench",
      };
      const container = containerMap[service] ?? `acb-${service}`;
      try {
        const { stdout } = await execAsync(`docker logs ${container} --tail ${lines} 2>&1`);
        return stdout || "(no output)";
      } catch {
        // Fallback: journalctl on VPS
        try {
          const { stdout } = await execAsync(
            `journalctl -u acb-${service} --lines=${lines} --no-pager 2>&1`,
          );
          return stdout || "(no output)";
        } catch (e2: unknown) {
          return `Error: ${e2 instanceof Error ? e2.message : String(e2)}`;
        }
      }
    }

    case "trigger_deploy": {
      const branch = String(args.branch ?? "main");
      const scriptPath = path.join(REPO_PATH, "deploy", "hostinger", "deploy.sh");
      try {
        const { stdout, stderr } = await execAsync(`bash "${scriptPath}" 2>&1`, {
          cwd: REPO_PATH,
          timeout: 300_000,
          env: { ...process.env, DEPLOY_BRANCH: branch },
        });
        return (stdout + stderr).slice(0, 5_000);
      } catch (e: unknown) {
        const err = e as { stdout?: string; message?: string };
        return (err.stdout || err.message || String(e)).slice(0, 5_000);
      }
    }

    case "write_file": {
      const target = safeResolve(String(args.path ?? ""));
      if (!target) return "Error: path is outside the repository";
      const content = String(args.content ?? "");
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf-8");
        const lines = content.split("\n").length;
        return `Written ${lines} lines to ${String(args.path)}`;
      } catch (e) {
        return `Error writing file: ${e}`;
      }
    }

    case "search_code": {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return "Error: pattern is required";
      const searchDir = args.path ? (safeResolve(String(args.path)) ?? REPO_PATH) : REPO_PATH;
      const fileGlob = args.file_pattern ? `--include="${String(args.file_pattern)}"` : "";
      try {
        const { stdout } = await execAsync(
          `grep -rn ${fileGlob} --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.venv -E "${pattern.replace(/"/g, '\\"')}" "${searchDir}" 2>&1 | head -80`,
          { cwd: REPO_PATH },
        );
        return stdout.slice(0, 8000) || "(no matches)";
      } catch (e: unknown) {
        const err = e as { stdout?: string; code?: number };
        if (err.code === 1) return "(no matches)";
        return err.stdout?.slice(0, 2000) || `Error: ${String(e)}`;
      }
    }

    case "git_commit": {
      const message = String(args.message ?? "");
      if (!message) return "Error: commit message is required";
      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      try {
        for (const p of paths) {
          if (!safeResolve(p)) return `Error: path '${p}' is outside the repository`;
        }
        const addCmd = paths.length > 0
          ? `git add ${paths.map((p) => `"${path.resolve(REPO_PATH, p)}"`).join(" ")}`
          : "git add -A";
        await execAsync(addCmd, { cwd: REPO_PATH });
        const { stdout } = await execAsync(
          `git commit -m "${message.replace(/"/g, '\\"')}"`,
          { cwd: REPO_PATH },
        );
        return stdout.trim();
      } catch (e: unknown) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    case "run_command": {
      const command = String(args.command ?? "");
      if (!command) return "Error: command is required";
      const blocked = /(rm\s+-rf\s+\/|mkfs|dd\s+if=)/i;
      if (blocked.test(command)) return "Error: command blocked for safety";
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: REPO_PATH,
          timeout: 60_000,
          env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/root/.local/bin:/home/acb/.local/bin` },
        });
        return ((stdout || "") + (stderr || "")).slice(0, 8_000) || "(no output)";
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return ((err.stdout ?? "") + (err.stderr ?? "") || err.message || String(e)).slice(0, 8_000);
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `\
You are a CommandCenter developer assistant with direct shell-level access to the CommandCenter repository at: ${REPO_PATH}

CommandCenter is a headless, self-mutating multi-agent orchestration platform built on Microsoft Agent Framework (MAF). Organisation: Fracktal Works.

Key directories:
- apps/orchestrator/   MAF agent execution engine
- apps/gateway/        FastAPI gateway (port 8000)
- workbench/control_plane/  Next.js control plane (port 3001)
- packages/            Shared Python packages (acb_skills, acb_llm, acb_memory, acb_graph)
- infra/               Docker Compose, Postgres schema, LiteLLM config
- deploy/              VPS deployment scripts
- tests/               pytest unit + integration tests

Conventions:
- Python 3.11+ with uv package manager
- async/await throughout (no sync blocking in request paths)
- Type hints required on all public functions
- Run tests: uv run python -m pytest tests/ -x -v

You have access to these tools:
- read_file        — read any file in the repo (up to 8 KB)
- write_file       — write/create a file (read_file first to understand context)
- list_directory   — list directory contents
- search_code      — grep across the codebase (regex, optional file type filter)
- git_status       — show working tree status
- git_diff         — show uncommitted changes
- git_commit       — stage + commit changes (git add -A by default)
- run_command      — run any shell command (uv, npm, ruff, mypy, etc.) — 60 s timeout
- run_tests        — run pytest with verbose output
- view_logs        — tail Docker / systemd service logs
- trigger_deploy   — deploy to the Hostinger VPS (always confirm with user first)

Workflow for code changes:
1. search_code or read_file to understand the relevant code
2. write_file to apply the change
3. run_command to verify (ruff check, mypy, npm run build, or pytest)
4. git_commit to save the work — never push without explicit user instruction

Python conventions: uv run python -m pytest, uv run ruff check ., uv run mypy apps packages
TypeScript: cd workbench/control_plane && npm run build (or npm run lint)
Be concise and direct. Read before writing. Verify after changing.`;
}

// ── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Auth check — mirrors /api/agent/chat pattern
  const session = await auth();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }


  let messages: Array<{ role: string; content: string }>;
  let model: string;
  try {
    ({ messages, model = "copilot/claude-sonnet" } = await req.json());
  } catch {
    return new NextResponse("Invalid JSON body", { status: 400 });
  }

  // Probe gateway; fall back to direct Copilot API if unreachable.
  const gatewayUp = await isGatewayReachable();
  const llmClient = gatewayUp ? makeGatewayClient() : makeCopilotDirectClient();
  // When using direct Copilot, normalise model names (strip any provider prefix)
  const effectiveModel = gatewayUp ? model : model.replace(/^copilot\//, "");
  // Surface fallback status in the SSE stream so the UI can show it
  const usingFallback = !gatewayUp;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: buildSystemPrompt() },
        ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
      ];

      try {
        // Surface fallback info as a system-level SSE event so the UI can show a banner
        if (usingFallback) {
          send({ type: "gateway_down", fallback: "copilot-direct" });
        }

        // Tool-calling loop (max 10 iterations to prevent runaway)
        for (let i = 0; i < 10; i++) {
          const response = await llmClient.chat.completions.create({
            model: effectiveModel,
            messages: allMessages,
            tools: TOOLS,
            tool_choice: "auto",
            stream: false,
            max_tokens: 4096,
          });

          const choice = response.choices[0];

          if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
            // Push assistant message with tool calls into history
            allMessages.push(choice.message);

            // Execute all tool calls in this turn (in order)
            const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
            for (const tc of choice.message.tool_calls) {
              const toolArgs = JSON.parse(tc.function.arguments || "{}");

              send({ type: "tool_start", id: tc.id, name: tc.function.name, args: toolArgs });

              const result = await executeTool(tc.function.name, toolArgs);
              const success = !result.startsWith("Error:");

              send({
                type: "tool_end",
                id: tc.id,
                name: tc.function.name,
                result: result.slice(0, 2000), // cap for SSE payload
                success,
              });

              toolResults.push({ role: "tool", tool_call_id: tc.id, content: result });
            }
            allMessages.push(...toolResults);
            // Continue loop — next iteration gets text response based on tool results
            continue;
          }

          // finish_reason == "stop" or no tool calls — stream the final text
          const finalStream = await llmClient.chat.completions.create({
            model: effectiveModel,
            messages: allMessages,
            stream: true,
            max_tokens: 4096,
          });

          for await (const chunk of finalStream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) send({ type: "delta", content: delta });
          }

          send({ type: "done" });
          break;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: "error", content: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
