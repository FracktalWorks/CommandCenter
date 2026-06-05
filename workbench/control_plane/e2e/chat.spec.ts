import { expect, test, type Page } from "@playwright/test";

type AgentEntry = {
  name: string;
  description: string;
  tags: string[];
  integrations: string[];
};

type IntegrationStatus = {
  service: string;
  label: string;
  configured: boolean;
  mandatory: boolean;
};

type ChatRequest = {
  agentName: string;
  message: string;
  messages: Array<{ role: string; content: string }>;
  threadId: string;
  mode?: "copilot" | "litellm";
  model?: string;
  context?: string;
};

type ChatMockResponse = {
  delayMs?: number;
  events: Array<Record<string, unknown>>;
};

const AGENTS: AgentEntry[] = [
  {
    name: "sales-assistant",
    description: "Follows up with deals and drafts sales actions",
    tags: ["sales", "copilot"],
    integrations: ["zoho"],
  },
  {
    name: "delivery-ops",
    description: "Escalates stale work and summarizes delivery risk",
    tags: ["delivery", "ops"],
    integrations: [],
  },
];

const STATUSES: IntegrationStatus[] = [
  {
    service: "zoho",
    label: "Zoho CRM",
    configured: false,
    mandatory: true,
  },
];

const MODELS = [
  { id: "auto", label: "auto (SDK picks)", runtime: "copilot", group: "GitHub Copilot SDK" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", runtime: "copilot", group: "GitHub Copilot SDK" },
  { id: "tier1-local-qwen3", label: "Tier 1 — Gemini 2.5 Flash Lite (fast/triage)", runtime: "litellm", group: "LiteLLM (tier routing)" },
  { id: "tier2-sonnet", label: "Tier 2 — Gemini 2.5 Flash (drafting)", runtime: "litellm", group: "LiteLLM (tier routing)" },
  { id: "tier3-opus", label: "Tier 3 — Gemini 2.5 Flash (reasoning)", runtime: "litellm", group: "LiteLLM (tier routing)" },
];

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function installChatMocks(
  page: Page,
  responder: (body: ChatRequest, callIndex: number) => ChatMockResponse,
  requests: ChatRequest[],
) {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.route("**/api/chat/memories**", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "mem-1", memory: "Prefers concise pipeline summaries." },
          { id: "mem-2", memory: "Cares about next action owners and due dates." },
        ]),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/models/all", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: MODELS, source: "mock" }),
    });
  });

  await page.route("**/api/agent/list", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(AGENTS),
    });
  });

  await page.route(/.*\/api\/integrations\/status.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(STATUSES),
    });
  });

  await page.route("**/api/agent/chat", async (route) => {
    const body = route.request().postDataJSON() as ChatRequest;
    requests.push(body);
    const response = responder(body, requests.length - 1);
    if (response.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse(response.events),
    });
  });
}

async function gotoChat(page: Page) {
  await page.goto("/chat");
  await expect(page.getByText("Conversations")).toBeVisible();
  await expect(page.getByText("Unified chat · Copilot SDK + LiteLLM")).toBeVisible();
  await expect(page.getByPlaceholder(/Message orchestrator/i)).toBeVisible();
}

async function openAgentPicker(page: Page) {
  await page.getByRole("button", { name: "+ New session" }).click();
  await expect(page.getByText("New session", { exact: true })).toBeVisible();
}

test.describe("Unified chat interface", () => {
  test("loads the CommandCenter session with unified controls and memories", async ({ page }) => {
    const requests: ChatRequest[] = [];
    await installChatMocks(page, () => ({ events: [{ type: "done" }] }), requests);

    await gotoChat(page);

    await expect(page.getByText("General-purpose AI company brain").first()).toBeVisible();
    await expect(page.getByText("Memory (2)")).toBeVisible();
    await expect(page.getByText("Prefers concise pipeline summaries.")).toBeVisible();
    await expect(page.getByText("Chat with").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose send mode", exact: true })).toBeVisible();
    await expect(page.getByText("Copilot").first()).toBeVisible();
    expect(requests).toHaveLength(0);
  });

  test("creates a named-agent session in the same UI and surfaces missing integrations", async ({ page }) => {
    const requests: ChatRequest[] = [];
    await installChatMocks(
      page,
      (body) => ({
        events: [
          { type: "delta", content: `Guidance for ${body.message}` },
          { type: "done" },
        ],
      }),
      requests,
    );

    await gotoChat(page);
    await openAgentPicker(page);
    await page.getByRole("button", { name: /sales-assistant/i }).click();

    await expect(page.getByPlaceholder(/Message sales-assistant/i)).toBeVisible();
    await expect(page.getByText(/1 integration not configured/i)).toBeVisible();
    await page.getByRole("button", { name: /Zoho CRM \+ set up/i }).click();

    await expect(page.getByText(/I need to configure the Zoho CRM integration/i).first()).toBeVisible();
    await expect(page.getByText(/Guidance for I need to configure the Zoho CRM integration/i)).toBeVisible();
    expect(requests.at(-1)?.agentName).toBe("sales-assistant");
  });

  test("switches model runtime and sends LiteLLM-routed requests", async ({ page }) => {
    const requests: ChatRequest[] = [];
    await installChatMocks(
      page,
      (body) => ({
        events: [
          { type: "delta", content: `Runtime ${body.mode} / model ${body.model}` },
          { type: "done" },
        ],
      }),
      requests,
    );

    await gotoChat(page);

    await page.locator("select").selectOption("tier3-opus");
    await expect(page.getByText("LiteLLM").first()).toBeVisible();

    await page.getByPlaceholder(/Message orchestrator/i).fill("Summarize delivery risk");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page.getByText("Runtime litellm / model tier3-opus")).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.mode).toBe("litellm");
    expect(requests[0]?.model).toBe("tier3-opus");
  });

  test("supports queued follow-up messages while a response is in flight", async ({ page }) => {
    const requests: ChatRequest[] = [];
    await installChatMocks(
      page,
      (body, callIndex) => ({
        delayMs: callIndex === 0 ? 800 : 0,
        events: [
          { type: "delta", content: `Answer ${callIndex + 1}: ${body.message}` },
          { type: "done" },
        ],
      }),
      requests,
    );

    await gotoChat(page);

    await page.getByRole("button", { name: "Choose send mode", exact: true }).click();
    await page.getByRole("button", { name: /⏱ Queue/i }).click();

    const input = page.getByPlaceholder(/Message orchestrator/i);
    await input.fill("First request");
    await page.getByRole("button", { name: "Queue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();

    await page.getByPlaceholder(/Queue a follow-up/i).fill("Second request");
    await page.getByRole("button", { name: "Queue", exact: true }).click();

    await expect(page.getByText(/1 message queued/i)).toBeVisible();
    await expect(page.getByText("Answer 1: First request")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Answer 2: Second request")).toBeVisible({ timeout: 5_000 });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.message).toBe("First request");
    expect(requests[1]?.message).toBe("Second request");
  });

  test("supports steer mode by interrupting the current response and prioritizing the next prompt", async ({ page }) => {
    const requests: ChatRequest[] = [];
    await installChatMocks(
      page,
      (body, callIndex) => ({
        delayMs: callIndex === 0 ? 1200 : 0,
        events: [
          { type: "delta", content: `Response ${callIndex + 1}: ${body.message}` },
          { type: "done" },
        ],
      }),
      requests,
    );

    await gotoChat(page);

    await page.getByRole("button", { name: "Choose send mode" }).click();
    await page.getByRole("button", { name: /Steer/i }).click();

    await page.getByPlaceholder(/Message orchestrator/i).fill("Slow draft");
    await page.getByRole("button", { name: "Steer" }).click();
    await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();

    await page.getByPlaceholder(/Steer a follow-up/i).fill("Use tighter language");
    await page.getByRole("button", { name: "Steer" }).click();

    await expect(page.getByText("Response 2: Use tighter language")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Response 1: Slow draft")).toHaveCount(0);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.message).toBe("Use tighter language");
  });

  test("renders tool blocks, markdown code, and MCQ choices that send the selected answer back", async ({ page }) => {
    const requests: ChatRequest[] = [];
    await installChatMocks(
      page,
      (body, callIndex) => {
        if (callIndex === 0) {
          return {
            events: [
              { type: "tool_start", id: "tool-1", name: "search_deals", args: { owner: "Vijay" } },
              { type: "tool_end", id: "tool-1", name: "search_deals", success: true, result: "Found 3 matching deals" },
              {
                type: "delta",
                content:
                  "```ts\nconst nextOwner = 'Asha';\n```\n\n```choices\nWhich account should I prioritize?\n- Acme Renewal\n- Globex Expansion\n- Skip for now\n```",
              },
              { type: "done" },
            ],
          };
        }

        return {
          events: [
            { type: "delta", content: `Selected: ${body.message}` },
            { type: "done" },
          ],
        };
      },
      requests,
    );

    await gotoChat(page);

    await page.getByPlaceholder(/Message orchestrator/i).fill("Which deal should I chase?");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page.getByText("Search Deals")).toBeVisible();
    await page.getByRole("button", { name: /Search Deals/i }).click();
    await expect(page.getByText("Found 3 matching deals")).toBeVisible();
    await expect(page.getByText("Which account should I prioritize?")).toBeVisible();
    await expect(page.getByText("const nextOwner = 'Asha';")).toBeVisible();

    await page.getByRole("button", { name: /Acme Renewal/i }).click();

    await expect(page.getByText("Selected: Acme Renewal")).toBeVisible({ timeout: 5_000 });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.message).toBe("Acme Renewal");
  });
});
