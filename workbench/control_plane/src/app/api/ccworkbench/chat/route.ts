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
 *   Primary: CC gateway LiteLLM endpoint (COPILOT_LLM_BASE_URL, port 8080).
 *   Gives access to every provider configured in CC (Copilot, DeepSeek, Groq, OpenRouter…).
 *   If the gateway is unreachable the request fails with a clear error — we do NOT fall
 *   back to direct api.githubcopilot.com because PATs are rejected by that endpoint.
 *
 * Env vars:
 *   COPILOT_LLM_BASE_URL   — LiteLLM base URL (default http://127.0.0.1:8080/v1)
 *   GATEWAY_INTERNAL_TOKEN — auth token for the gateway
 *   GITHUB_TOKEN           — PAT used only for GitHub API calls (Actions status, git push)
 *   CCWORKBENCH_REPO_PATH  — absolute path to the CC repo
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

/** LLM client pointing at the CC gateway LiteLLM endpoint. */
function makeGatewayClient(): OpenAI {
  return new OpenAI({ apiKey: GATEWAY_TOKEN, baseURL: LITELLM_BASE_URL });
}

// ── GitHub repo helper ──────────────────────────────────────────────────────

/** Parse owner/repo from git remote origin URL (ssh or https). */
async function getGitHubRepo(): Promise<{ owner: string; repo: string } | null> {
  try {
    const { stdout } = await execAsync("git remote get-url origin", { cwd: REPO_PATH });
    const url = stdout.trim();
    // ssh:  git@github.com:Owner/Repo.git
    // https: https://github.com/Owner/Repo.git
    const m = url.match(/github\.com[:\/]([\w.-]+)\/([\w.-]+?)(\.git)?$/);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  } catch {
    return null;
  }
}



// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the CommandCenter repository. Returns up to 32 KB of content.",
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
      name: "git_push",
      description:
        "Push committed changes to origin/main. This triggers the GitHub Actions CI/CD pipeline which runs lint → tests → deploy. Use this after git_commit to deploy changes. Always preferred over trigger_deploy.",
      parameters: {
        type: "object",
        properties: {
          branch: { type: "string", description: "Branch to push (default: main)." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_workflow_runs",
      description:
        "List the most recent GitHub Actions workflow runs for this repository. Use after git_push to check if CI/CD passed or failed.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of runs to return (default: 5)." },
          workflow: { type: "string", description: "Optional: workflow filename to filter by, e.g. 'deploy.yml'." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_workflow_logs",
      description:
        "Get the job steps and failure details for a specific GitHub Actions workflow run. Use when github_workflow_runs shows a failure.",
      parameters: {
        type: "object",
        properties: {
          run_id: { type: "number", description: "The workflow run ID from github_workflow_runs." },
        },
        required: ["run_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trigger_deploy",
      description:
        "EMERGENCY ONLY — run deploy.sh directly on the VPS, bypassing CI/CD. Use only when git_push is not possible (e.g. pipeline itself is broken). Always prefer git_push + github_workflow_runs instead.",
      parameters: {
        type: "object",
        properties: {
          branch: { type: "string", description: "Branch to deploy (default: main)." },
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
        return content.slice(0, 32_000);
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

    case "git_push": {
      const branch = String(args.branch ?? "main");
      // Use HTTPS with token so push works without an SSH agent.
      // Derive the HTTPS remote from the current origin (handles both ssh and https remotes).
      if (!GITHUB_TOKEN) return "Error: GITHUB_TOKEN is not set — cannot push";
      const ghRepo = await getGitHubRepo();
      if (!ghRepo) return "Error: could not determine GitHub repo from git remote";
      const httpsRemote = `https://${GITHUB_TOKEN}@github.com/${ghRepo.owner}/${ghRepo.repo}.git`;
      try {
        const { stdout, stderr } = await execAsync(
          `git push "${httpsRemote}" HEAD:${branch}`,
          { cwd: REPO_PATH, timeout: 60_000 },
        );
        const out = (stdout + stderr).trim();
        return out || `Pushed to origin/${branch}. GitHub Actions pipeline triggered — use github_workflow_runs to check status.`;
      } catch (e: unknown) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    case "github_workflow_runs": {
      const limit = Number(args.limit ?? 5);
      const workflow = args.workflow ? String(args.workflow) : null;
      const ghRepo = await getGitHubRepo();
      if (!ghRepo) return "Error: could not determine GitHub repo from git remote";
      if (!GITHUB_TOKEN) return "Error: GITHUB_TOKEN is not set";
      try {
        const qs = new URLSearchParams({ per_page: String(Math.min(limit, 10)) });
        // GitHub API accepts workflow file name as a path param, not a query param.
        // To filter by workflow we use the /actions/workflows/{filename}/runs endpoint.
        const runsPath = workflow
          ? `actions/workflows/${encodeURIComponent(workflow)}/runs`
          : "actions/runs";
        const url = `https://api.github.com/repos/${ghRepo.owner}/${ghRepo.repo}/${runsPath}?${qs}`;
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const data = await resp.json() as { workflow_runs: { id: number; name: string; status: string; conclusion: string | null; head_commit: { message: string }; created_at: string; html_url: string }[] };
        if (!data.workflow_runs?.length) return "No workflow runs found.";
        return data.workflow_runs.map((r) =>
          `[${r.id}] ${r.name} | ${r.status} | ${r.conclusion ?? "in_progress"} | ${r.head_commit.message.split("\n")[0].slice(0, 60)} | ${r.created_at}\n  ${r.html_url}`
        ).join("\n\n");
      } catch (e) {
        return `Error: ${String(e)}`;
      }
    }

    case "github_workflow_logs": {
      const runId = Number(args.run_id);
      if (!runId) return "Error: run_id is required";
      const ghRepo = await getGitHubRepo();
      if (!ghRepo) return "Error: could not determine GitHub repo from git remote";
      if (!GITHUB_TOKEN) return "Error: GITHUB_TOKEN is not set";
      try {
        const url = `https://api.github.com/repos/${ghRepo.owner}/${ghRepo.repo}/actions/runs/${runId}/jobs`;
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const data = await resp.json() as { jobs: { name: string; status: string; conclusion: string | null; steps: { name: string; status: string; conclusion: string | null; number: number }[] }[] };
        if (!data.jobs?.length) return "No jobs found for this run.";
        return data.jobs.map((job) => {
          const failedSteps = job.steps.filter((s) => s.conclusion === "failure");
          const stepSummary = failedSteps.length
            ? `  FAILED STEPS:\n${failedSteps.map((s) => `    - Step ${s.number}: ${s.name}`).join("\n")}`
            : `  All ${job.steps.length} steps passed`;
          return `Job: ${job.name} | ${job.conclusion ?? job.status}\n${stepSummary}`;
        }).join("\n\n");
      } catch (e) {
        return `Error: ${String(e)}`;
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
      const fileGlob = args.file_pattern ? String(args.file_pattern).replace(/[^a-zA-Z0-9.*_-]/g, "") : "";
      // Pass pattern as a separate argument via env to avoid shell injection
      try {
        const { stdout } = await execAsync(
          `grep -rn ${fileGlob ? `--include="${fileGlob}"` : ""} --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.venv -E "$GREP_PAT" "${searchDir}" 2>&1 | head -80`,
          { cwd: REPO_PATH, env: { ...process.env, GREP_PAT: pattern } },
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
      // Block destructive ops and direct git push (must use git_push tool which enforces HTTPS+token)
      const blocked = /(rm\s+-rf\s+\/|mkfs|dd\s+if=|git\s+push)/i;
      if (blocked.test(command)) return "Error: command blocked — use the git_push tool to push changes";
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
- read_file               — read any file in the repo (up to 8 KB)
- write_file              — write/create a file (always read_file first)
- list_directory          — list directory contents
- search_code             — grep across the codebase (regex, file type filter)
- git_status              — show working tree status
- git_diff                — show uncommitted changes
- git_commit              — stage + commit (git add -A by default)
- git_push                — push to origin → triggers GitHub Actions CI/CD pipeline
- github_workflow_runs    — list recent Actions runs (check deploy status after push)
- github_workflow_logs    — get job steps + failure details for a specific run ID
- run_command             — run any shell command (uv, npm, ruff, mypy…) — 60 s timeout
- run_tests               — run pytest with verbose output
- view_logs               — tail Docker / systemd service logs
- trigger_deploy          — EMERGENCY ONLY: run deploy.sh directly, bypassing CI/CD

## Deployment workflow (ALWAYS use this)

1. search_code / read_file — understand the code
2. write_file — make the change
3. run_command — verify: ruff check, mypy, npm run build, or pytest as appropriate
4. git_commit — commit with a clear message
5. git_push — pushes to origin/main and triggers GitHub Actions:
   lint → unit tests → SSH deploy → workbench rebuild → smoke test
6. github_workflow_runs — check the pipeline status (poll until conclusion != null)
7. If a run FAILED: use github_workflow_logs with the run_id to see which step failed

NEVER call trigger_deploy unless the user explicitly says the pipeline is broken.
NEVER push without running at least a basic verification step first.

## Python conventions
uv run python -m pytest tests/ -x -v
uv run ruff check . --fix
uv run mypy apps packages --ignore-missing-imports

## TypeScript conventions
cd workbench/control_plane && npm run build

Be concise and direct. Read before writing. Verify before pushing.`;
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
  let thinkMode: string;
  try {
    ({ messages, model = "copilot/claude-sonnet", thinkMode = "auto" } = await req.json());
  } catch {
    return new NextResponse("Invalid JSON body", { status: 400 });
  }

  const llmClient = makeGatewayClient();

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
        // Tool-calling loop (max 10 iterations to prevent runaway)
        for (let i = 0; i < 10; i++) {
          const response = await llmClient.chat.completions.create({
            model,
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
          // Pass thinking_budget when thinkMode != "auto" (supported by Copilot/Anthropic models)
          const thinkingOpts = thinkMode === "max"
            ? { thinking: { type: "enabled" as const, budget_tokens: 10_000 } }
            : thinkMode === "thinking"
            ? { thinking: { type: "enabled" as const, budget_tokens: 3_000 } }
            : {};
          const finalStream = await llmClient.chat.completions.create({
            model,
            messages: allMessages,
            stream: true,
            max_tokens: 4096,
            ...thinkingOpts,
          } as Parameters<typeof llmClient.chat.completions.create>[0]);

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
