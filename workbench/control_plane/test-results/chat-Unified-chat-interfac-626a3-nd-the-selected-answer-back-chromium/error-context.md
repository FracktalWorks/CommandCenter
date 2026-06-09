# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat.spec.ts >> Unified chat interface >> renders tool blocks, markdown code, and MCQ choices that send the selected answer back
- Location: e2e\chat.spec.ts:288:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Conversations')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByText('Conversations')

```

```yaml
- img
- heading "This page couldn’t load" [level=1]
- paragraph: Reload to try again, or go back.
- button "Reload"
- button "Back"
```

# Test source

```ts
  39  |   {
  40  |     name: "delivery-ops",
  41  |     description: "Escalates stale work and summarizes delivery risk",
  42  |     tags: ["delivery", "ops"],
  43  |     integrations: [],
  44  |   },
  45  | ];
  46  | 
  47  | const STATUSES: IntegrationStatus[] = [
  48  |   {
  49  |     service: "zoho",
  50  |     label: "Zoho CRM",
  51  |     configured: false,
  52  |     mandatory: true,
  53  |   },
  54  | ];
  55  | 
  56  | const MODELS = [
  57  |   { id: "auto", label: "auto (SDK picks)", runtime: "copilot", group: "GitHub Copilot SDK" },
  58  |   { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", runtime: "copilot", group: "GitHub Copilot SDK" },
  59  |   { id: "tier1-local-qwen3", label: "Tier 1 — Gemini 2.5 Flash Lite (fast/triage)", runtime: "litellm", group: "LiteLLM (tier routing)" },
  60  |   { id: "tier2-sonnet", label: "Tier 2 — Gemini 2.5 Flash (drafting)", runtime: "litellm", group: "LiteLLM (tier routing)" },
  61  |   { id: "tier3-opus", label: "Tier 3 — Gemini 2.5 Flash (reasoning)", runtime: "litellm", group: "LiteLLM (tier routing)" },
  62  | ];
  63  | 
  64  | function sse(events: Array<Record<string, unknown>>): string {
  65  |   return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  66  | }
  67  | 
  68  | async function installChatMocks(
  69  |   page: Page,
  70  |   responder: (body: ChatRequest, callIndex: number) => ChatMockResponse,
  71  |   requests: ChatRequest[],
  72  | ) {
  73  |   await page.addInitScript(() => {
  74  |     window.localStorage.clear();
  75  |   });
  76  | 
  77  |   await page.route("**/api/chat/memories**", async (route) => {
  78  |     const method = route.request().method();
  79  |     if (method === "GET") {
  80  |       await route.fulfill({
  81  |         status: 200,
  82  |         contentType: "application/json",
  83  |         body: JSON.stringify([
  84  |           { id: "mem-1", memory: "Prefers concise pipeline summaries." },
  85  |           { id: "mem-2", memory: "Cares about next action owners and due dates." },
  86  |         ]),
  87  |       });
  88  |       return;
  89  |     }
  90  | 
  91  |     await route.fulfill({
  92  |       status: 200,
  93  |       contentType: "application/json",
  94  |       body: JSON.stringify({ ok: true }),
  95  |     });
  96  |   });
  97  | 
  98  |   await page.route("**/api/models/all", async (route) => {
  99  |     await route.fulfill({
  100 |       status: 200,
  101 |       contentType: "application/json",
  102 |       body: JSON.stringify({ models: MODELS, source: "mock" }),
  103 |     });
  104 |   });
  105 | 
  106 |   await page.route("**/api/agent/list", async (route) => {
  107 |     await route.fulfill({
  108 |       status: 200,
  109 |       contentType: "application/json",
  110 |       body: JSON.stringify(AGENTS),
  111 |     });
  112 |   });
  113 | 
  114 |   await page.route(/.*\/api\/integrations\/status.*/, async (route) => {
  115 |     await route.fulfill({
  116 |       status: 200,
  117 |       contentType: "application/json",
  118 |       body: JSON.stringify(STATUSES),
  119 |     });
  120 |   });
  121 | 
  122 |   await page.route("**/api/agent/chat", async (route) => {
  123 |     const body = route.request().postDataJSON() as ChatRequest;
  124 |     requests.push(body);
  125 |     const response = responder(body, requests.length - 1);
  126 |     if (response.delayMs) {
  127 |       await new Promise((resolve) => setTimeout(resolve, response.delayMs));
  128 |     }
  129 |     await route.fulfill({
  130 |       status: 200,
  131 |       contentType: "text/event-stream",
  132 |       body: sse(response.events),
  133 |     });
  134 |   });
  135 | }
  136 | 
  137 | async function gotoChat(page: Page) {
  138 |   await page.goto("/chat");
> 139 |   await expect(page.getByText("Conversations")).toBeVisible();
      |                                                 ^ Error: expect(locator).toBeVisible() failed
  140 |   await expect(page.getByText("Unified chat · Copilot SDK + LiteLLM")).toBeVisible();
  141 |   await expect(page.getByPlaceholder(/Message orchestrator/i)).toBeVisible();
  142 | }
  143 | 
  144 | async function openAgentPicker(page: Page) {
  145 |   await page.getByRole("button", { name: "+ New session" }).click();
  146 |   await expect(page.getByText("New session", { exact: true })).toBeVisible();
  147 | }
  148 | 
  149 | test.describe("Unified chat interface", () => {
  150 |   test("loads the CommandCenter session with unified controls and memories", async ({ page }) => {
  151 |     const requests: ChatRequest[] = [];
  152 |     await installChatMocks(page, () => ({ events: [{ type: "done" }] }), requests);
  153 | 
  154 |     await gotoChat(page);
  155 | 
  156 |     await expect(page.getByText("General-purpose AI company brain").first()).toBeVisible();
  157 |     await expect(page.getByText("Memory (2)")).toBeVisible();
  158 |     await expect(page.getByText("Prefers concise pipeline summaries.")).toBeVisible();
  159 |     await expect(page.getByText("Chat with").first()).toBeVisible();
  160 |     await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  161 |     await expect(page.getByRole("button", { name: "Choose send mode", exact: true })).toBeVisible();
  162 |     await expect(page.getByText("Copilot").first()).toBeVisible();
  163 |     expect(requests).toHaveLength(0);
  164 |   });
  165 | 
  166 |   test("creates a named-agent session in the same UI and surfaces missing integrations", async ({ page }) => {
  167 |     const requests: ChatRequest[] = [];
  168 |     await installChatMocks(
  169 |       page,
  170 |       (body) => ({
  171 |         events: [
  172 |           { type: "delta", content: `Guidance for ${body.message}` },
  173 |           { type: "done" },
  174 |         ],
  175 |       }),
  176 |       requests,
  177 |     );
  178 | 
  179 |     await gotoChat(page);
  180 |     await openAgentPicker(page);
  181 |     await page.getByRole("button", { name: /sales-assistant/i }).click();
  182 | 
  183 |     await expect(page.getByPlaceholder(/Message sales-assistant/i)).toBeVisible();
  184 |     await expect(page.getByText(/1 integration not configured/i)).toBeVisible();
  185 |     await page.getByRole("button", { name: /Zoho CRM \+ set up/i }).click();
  186 | 
  187 |     await expect(page.getByText(/I need to configure the Zoho CRM integration/i).first()).toBeVisible();
  188 |     await expect(page.getByText(/Guidance for I need to configure the Zoho CRM integration/i)).toBeVisible();
  189 |     expect(requests.at(-1)?.agentName).toBe("sales-assistant");
  190 |   });
  191 | 
  192 |   test("switches model runtime and sends LiteLLM-routed requests", async ({ page }) => {
  193 |     const requests: ChatRequest[] = [];
  194 |     await installChatMocks(
  195 |       page,
  196 |       (body) => ({
  197 |         events: [
  198 |           { type: "delta", content: `Runtime ${body.mode} / model ${body.model}` },
  199 |           { type: "done" },
  200 |         ],
  201 |       }),
  202 |       requests,
  203 |     );
  204 | 
  205 |     await gotoChat(page);
  206 | 
  207 |     await page.locator("select").selectOption("tier3-opus");
  208 |     await expect(page.getByText("LiteLLM").first()).toBeVisible();
  209 | 
  210 |     await page.getByPlaceholder(/Message orchestrator/i).fill("Summarize delivery risk");
  211 |     await page.getByRole("button", { name: "Send", exact: true }).click();
  212 | 
  213 |     await expect(page.getByText("Runtime litellm / model tier3-opus")).toBeVisible();
  214 |     expect(requests).toHaveLength(1);
  215 |     expect(requests[0]?.mode).toBe("litellm");
  216 |     expect(requests[0]?.model).toBe("tier3-opus");
  217 |   });
  218 | 
  219 |   test("supports queued follow-up messages while a response is in flight", async ({ page }) => {
  220 |     const requests: ChatRequest[] = [];
  221 |     await installChatMocks(
  222 |       page,
  223 |       (body, callIndex) => ({
  224 |         delayMs: callIndex === 0 ? 800 : 0,
  225 |         events: [
  226 |           { type: "delta", content: `Answer ${callIndex + 1}: ${body.message}` },
  227 |           { type: "done" },
  228 |         ],
  229 |       }),
  230 |       requests,
  231 |     );
  232 | 
  233 |     await gotoChat(page);
  234 | 
  235 |     await page.getByRole("button", { name: "Choose send mode", exact: true }).click();
  236 |     await page.getByRole("button", { name: /⏱ Queue/i }).click();
  237 | 
  238 |     const input = page.getByPlaceholder(/Message orchestrator/i);
  239 |     await input.fill("First request");
```