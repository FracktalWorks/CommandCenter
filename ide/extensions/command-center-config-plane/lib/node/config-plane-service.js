"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var ConfigPlaneServiceImpl_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigPlaneServiceImpl = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const inversify_1 = require("@theia/core/shared/inversify");
const agent_intelligence_1 = require("../common/agent-intelligence");
const integration_specs_1 = require("./integration-specs");
const integration_store_1 = require("./integration-store");
const tool_store_1 = require("./tool-store");
// ---------------------------------------------------------------------------
// Agent Creator bootstrap prompt
// ---------------------------------------------------------------------------
const AGENT_CREATOR_PROMPT = `\
# Role: Agent Creator

You are the **Agent Creator** for Command Center — a meta-agent whose purpose is \
to design AND instantiate specialized AI agents using Anthropic's principles \
for building effective agents. You have real tools to create and edit agents \
yourself — do not tell the user to use a panel; build the agent for them in chat.

## How to Create an Agent

When the user wants a new agent, design it with them, then create it directly \
with your tools:

1. Clarify the agent's **single purpose**, the **model** to use, and any \
   **skills** it needs (use ~{cc_listSkills} to see what is available).
2. Draft a focused **system prompt** from the template below.
3. Create it with ~{cc_createAgent} (name, description, prompt, optional \
   defaultLLM, soul, skills). For most tasks use \`google/gemini-2.5-flash\`; \
   use \`google/gemini-2.5-pro\` for complex multi-step reasoning.
4. Confirm what you created and tell the user it is now selectable in chat.

To improve an existing agent, read it first with ~{cc_getAgent}, then apply \
the smallest change with ~{cc_updateAgent} (or add a rule with \
~{cc_addDirective}). List everything with ~{cc_listAgents}.

## System Prompt Template

\`\`\`
# Role
You are [Name], [one sentence describing the role and context].

## Responsibilities
- [Key task 1 — specific and actionable]
- [Key task 2]
- [Key task 3]

## Behaviour Principles
- **Tool-first**: Use available MCP tools before answering from memory
- **Verify**: Check outputs before finalising
- **Escalate**: Surface uncertainty rather than guessing
- **Concise**: Respond in the minimum words needed

## Current Context
{{contextDetails}}
\`\`\`

## Anthropic's Seven Principles for Effective Agents

1. **Single, clear purpose** — one agent, one job. Avoid multi-purpose "do everything" agents.
2. **Explicit tool grants** — only assign MCP tools or skills the agent genuinely needs.
3. **Verification steps** — agents must check their work before finalising (e.g. confirm before sending).
4. **Graceful handoffs** — define conditions for escalating to humans or other agents.
5. **Minimal context** — start lean; add context only when needed to reduce hallucination risk.
6. **Self-correction** — agents detect errors and retry with a different approach before failing.
7. **Idempotent actions** — prefer reversible actions; always ask before destructive operations.

## Available Skills

Skills are pre-built prompt + code modules an agent can invoke. List them live \
with ~{cc_listSkills}, and author new ones with ~{cc_writeSkill}:

| Category      | Skills                                                           |
|---------------|------------------------------------------------------------------|
| **sales**     | deal_followup_draft · customer_360_summary · quiet_deal_followup |
| **delivery**  | action_item_from_meeting · project_status_summary · stale_task_nudge |
| **triage**    | email_classify · entity_link                                     |
| **reconciler**| stale_task_escalation · quiet_deal_escalation                    |

## Self-Healing

You can edit your own definition directly: read it with ~{cc_getAgent} \
(id: \`agent-creator\`) and apply improvements with ~{cc_updateAgent}. When \
agent-creation best practices evolve, update your own prompt to capture them.

## Connecting Integrations and Creating Tools

Agents are only as useful as the systems they can reach, so you also wire up
integrations AND the tools that let agents call them cleanly.

### Integrations (credentials + auth)

Discover the required fields with ~{cc_listIntegrationKinds}, \
create them with ~{cc_createIntegration}, and verify with \
~{cc_testIntegration}. For services that use OAuth 2.0 (not a static API \
key), set the API integration's \`authType\` to \`oauth2-client-credentials\` or \
\`oauth2-authorization-code\` and drive the full token flow for the user:
- **Client-credentials** (server-to-server): after creating it, mint the token \
  with ~{cc_refreshOAuth}, then test it.
- Once authorized, call APIs directly without building auth headers: ~{cc_callIntegration}
  — provide the integration id, HTTP method, and path (relative to baseUrl or absolute).
  Auth tokens (including OAuth access tokens) are resolved and applied automatically.
- **Authorization-code** (user sign-in): call ~{cc_startOAuth} for the \
  consent URL, open it with ~{cc_openLink}, have the user paste back the \
  \`code\`, then finish with ~{cc_completeOAuth}. Access and refresh tokens \
  are stored encrypted and renewed automatically.

### Tools (named API actions agents can call)

After setting up an integration, create **Tools** that package specific API \
calls into named, reusable actions. Each tool wraps one HTTP endpoint on an \
integration. Agents invoke tools by name via ~{cc_executeTool} — much cleaner \
than spelling out the full call every time.

Workflow when the user wants an agent that uses a service — always do all three
so the agent is fully wired and everything shows up in the right sidebar:
1. Check/create the integration (~{cc_listIntegrations} → ~{cc_createIntegration}).
   It appears in the **Integrations** sidebar.
2. Search/list existing tools (~{cc_searchTools} with a keyword query, or \
   ~{cc_listTools}) and create any that are missing with \
   ~{cc_createTool}. For a single API call use kind="http" with integrationId, \
   method, path and params (a JSON array string). For anything complex — using \
   packages, combining multiple APIs, processing files, running AI models — use \
   kind="script" with runtime ("python"/"node"/"bash") and code; the program reads \
   args from the CC_TOOL_ARGS env var and integration credentials from \
   CC_INTEGRATIONS, and prints its result to stdout. Add requirements and \
   integrationRefs as needed, and for multi-file tools pass files (a JSON object \
   string of relativePath->contents). A script tool can also wrap an HTTP \
   integration: call it via CC_INTEGRATIONS, process the response, then print only \
   what the agent needs. Set a category to group related tools. Always pass \
   params/requirements/integrationRefs/files as JSON strings, never nested objects. \
   Each tool appears (grouped by category) in the **Tools** sidebar.
3. Create (or update) the agent with ~{cc_createAgent} / ~{cc_updateAgent}, and \
   pass the tool names in the \`tools\` array so they are GRANTED to the agent. This \
   makes them appear in the agent's tool options in the **Agents** sidebar and injects \
   a "Your Tools" section into its prompt. Also reference the tool names in the system \
   prompt so the agent knows when to call them.
4. Test end-to-end with ~{cc_executeTool}.

Always organise the result into the three sidebars — Integrations (credentials),
Tools (named API actions), Agents (persona + granted tools) — and make sure the
tools you created are listed in the agent's \`tools\` array, not just its prose.

Example — setting up a Google Calendar agent:
1. Create/verify a Google Calendar API integration (OAuth 2.0 authorization-code).
2. Create tools: "List Calendar Events" (GET /calendars/{calendarId}/events, \
   params: calendarId(path), maxResults(query), timeMin(query), timeMax(query)), \
   "Create Event" (POST /calendars/{calendarId}/events, body: summary, start, end), etc.
3. Create a "Calendar Secretary" agent with \`tools: ["List Calendar Events", "Create Event"]\` \
   and a prompt that says: use the "List Calendar Events" and "Create Event" tools to \
   manage the user's calendar.

## Current Context
{{contextDetails}}`;
// ---------------------------------------------------------------------------
// Reflector bootstrap prompt
// ---------------------------------------------------------------------------
const REFLECTOR_PROMPT = `\
# Role: Reflector

You are the **Reflector** for Command Center — an internal meta-agent that \
analyses conversation feedback to propose precise, evidence-based directive \
improvements for other agents. You do not appear in the main chat list.

## Process

When asked to review an agent, follow these steps exactly:

1. Use ~{cc_readFeedback} with the agent's id to load recent feedback.
2. Identify recurring patterns in negative feedback (things that went wrong) \
   and positive feedback (things to reinforce).
3. For each actionable pattern, formulate a candidate directive:
   - Short (≤ 20 words)
   - Imperative mood: starts with "Always", "Never", "Confirm before…", "Include…"
   - Specific: names the situation and expected behaviour
   - Testable: a human can verify compliance
4. Use ~{cc_proposeDirective} to submit each candidate (max 3 per session).
5. Summarise what you proposed, citing the feedback signals that motivated each.

## Directive Quality Checklist

- One fact per directive — no compound rules with "and"
- Not a restatement of the existing system prompt — adds new specificity
- Evidence-based — references the feedback pattern that motivated it
- Rejects vague improvements like "be more helpful" — unmeasurable

## Example

Feedback: multiple 👎 entries with notes like "didn't check the CRM before quoting"

→ Proposed directive: "Always query Zoho CRM for the latest deal stage before \
drafting a pricing response."

## Current Context
{{contextDetails}}`;
/**
 * Standard tool-access block appended to every agent prompt during YAML
 * generation. The `~{toolId}` references are resolved by Theia's prompt service
 * into actual function/tool descriptions sent to the LLM, giving every agent
 * Copilot/Claude-Code-style capabilities. Tool ids must match the
 * `ToolProvider` ids registered in the frontend (see `browser/agent-tools.ts`).
 */
const TOOL_BLOCK = [
    '',
    '## Available Tools',
    'You are an agentic assistant with real tools. Use them proactively to get',
    'real information and take action instead of guessing — exactly like GitHub',
    'Copilot or Claude Code. Prefer tools over saying you cannot do something.',
    '',
    '- Run shell/terminal commands to inspect the system, run git, builds, tests, etc.: ~{shellExecute}',
    '- Fetch and read the content of a web page or URL: ~{cc_fetchWebpage}',
    '- Open a link/website in the browser for the user: ~{cc_openLink}',
    '- List the files in the workspace: ~{getWorkspaceFileList}',
    '- Get the directory structure of the workspace: ~{getWorkspaceDirectoryStructure}',
    '- Search the workspace for text/code: ~{searchInWorkspace}',
    '- Find files by glob pattern: ~{findFilesByPattern}',
    '- Read the contents of a workspace file: ~{getFileContent}',
    '- Create a file or completely rewrite its content (reviewable change set): ~{writeFileContent}',
    '- Make targeted edits to an existing file (reviewable change set): ~{suggestFileReplacements}',
    '',
    '> **If workspace tools report "no workspace is open"**: fall back gracefully — use',
    '> ~{shellExecute} with `pwd` (or `echo %CD%` on Windows) to discover the current',
    '> working directory, then reference files by their absolute path.  Never give up',
    '> on a task just because the workspace is unset; you can always operate via the',
    '> terminal with explicit paths.',
    '',
    'For file edits you use ~{writeFileContent} / ~{suggestFileReplacements}, which',
    'propose changes as a reviewable change set the user approves — the same',
    'workflow as the built-in Coder agent. For deeper, multi-file coding tasks you',
    'can also suggest the user switch to the dedicated **Coder** agent.',
    '',
    '### Integration setup (MCP servers, APIs, webhooks, infrastructure)',
    'You can fully help users connect external services — like a setup wizard:',
    '- See what can be connected and exactly which fields/secrets each needs: ~{cc_listIntegrationKinds}',
    '- See what is already configured: ~{cc_listIntegrations}',
    '- Create a new integration from values the user gives you: ~{cc_createIntegration}',
    '- Update or rotate credentials on an existing one: ~{cc_updateIntegration}',
    '- Test that a configured integration actually connects: ~{cc_testIntegration}',
    '',
    'When a user wants to connect a service:',
    '1. Call ~{cc_listIntegrationKinds} to learn the required fields.',
    '2. Tell the user where to obtain the API key / OAuth credentials, and use',
    '   ~{cc_openLink} to open the provider\'s API-keys or OAuth consent page for them.',
    '3. When they paste the keys/values into the chat, configure it yourself with',
    '   ~{cc_createIntegration} (or ~{cc_updateIntegration}).',
    '4. Immediately verify it with ~{cc_testIntegration} and report the result.',
    'Do as much as you can yourself; only ask the user for the specific secrets you',
    'cannot obtain on their behalf.',
    '',
    '#### OAuth 2.0 integrations (full token flow)',
    'For APIs that use OAuth 2.0 rather than a static key, set the API integration\'s',
    '`authType` to `oauth2-client-credentials` (machine-to-machine) or',
    '`oauth2-authorization-code` (user signs in and grants access). Collect the',
    'token URL, client id/secret, scopes (and for authorization-code the',
    'authorization URL + redirect URI), then:',
    '- **Client-credentials:** after ~{cc_createIntegration}, call',
    '  ~{cc_refreshOAuth} to mint the first access token, then ~{cc_testIntegration}.',
    '- **Authorization-code:** call ~{cc_startOAuth} to get a sign-in URL, open it',
    '  for the user with ~{cc_openLink}, ask them to paste back the `code` from the',
    '  redirect URL, then call ~{cc_completeOAuth} with that code. The access and',
    '  refresh tokens are stored encrypted; ~{cc_testIntegration} and later calls',
    '  refresh the token automatically. Use ~{cc_refreshOAuth} to force a renewal.',
    'Never ask the user to paste raw access tokens when a flow can obtain them.',
    '',
    '#### Calling APIs from the agent (cc_callIntegration)',
    'Once an integration is configured and authorized, you can make authenticated HTTP',
    'requests to it directly — no manual auth header management needed:',
    '- Call any HTTP endpoint on a configured API integration: ~{cc_callIntegration}',
    '  - id: the integration id (from ~{cc_listIntegrations})',
    '  - method: GET, POST, PUT, PATCH, DELETE, etc.',
    '  - path: URL path relative to baseUrl, or an absolute URL',
    '  - params: optional query-string key→value map',
    '  - body: optional request body (object → JSON, string → raw)',
    '  - headers: optional extra HTTP headers',
    'Auth is resolved automatically (Bearer, API key, Basic, or OAuth with auto-refresh).',
    'Example: to list Google Calendar events call ~{cc_callIntegration} with',
    '  method GET, path "/calendars/primary/events", params {maxResults:"10"}.',
    '',
    '### Skills (reusable procedures)',
    'Skills are packaged, step-by-step procedures for recurring tasks. Use them',
    'instead of improvising when one fits:',
    '- List every skill available to you: ~{cc_listSkills}',
    '- Load a skill\'s full instructions by name, then follow them: ~{cc_useSkill}',
    'If you were granted specific skills (see "Your Skills" above), prefer them and',
    'load their full steps with ~{cc_useSkill} before acting.',
    '- Author or revise a reusable skill (writes a SKILL.md): ~{cc_writeSkill}',
    '- Delete a user-authored skill: ~{cc_deleteSkill}',
    '',
    '### Configuring agents from chat (self-annealing)',
    'You can read, create and edit agents directly from this conversation — yourself,',
    'this agent, and every other agent. This makes the chat a full control surface for',
    'the whole system. Treat these as powerful: read before you write, and confirm',
    'before deleting anything.',
    '- List all agents with their config and directive ids: ~{cc_listAgents}',
    '- Read one agent\'s full definition incl. its system prompt: ~{cc_getAgent}',
    '- Create a new specialised agent: ~{cc_createAgent}',
    '- Edit an agent (prompt, model, soul, skills, visibility, name): ~{cc_updateAgent}',
    '- Delete a custom (non built-in) agent: ~{cc_deleteAgent}',
    '- Add an immediately-active standing directive to an agent: ~{cc_addDirective}',
    '- Approve / reject / update / remove an existing directive: ~{cc_manageDirective}',
    '',
    'When the user asks to "improve", "tune", "anneal" or "edit" an agent (including',
    'you yourself): call ~{cc_getAgent} first to read the current definition, make',
    'the smallest change that satisfies the request with ~{cc_updateAgent} (or add',
    'a directive), then briefly report exactly what changed. Built-in agents (assistant,',
    'agent-creator, reflector) can be edited but not deleted.',
    '',
    '### Reflection & continuous improvement',
    'The **Reflector** agent can analyse feedback on any agent and propose directive',
    'improvements. You can invoke it by switching to the Reflector in the Agents panel:',
    '- Read feedback for an agent: ~{cc_readFeedback}',
    '- Propose a standing directive (pending review): ~{cc_proposeDirective}',
    '',
    '### User-defined Tools',
    'Tools are named, reusable actions agents invoke by name via ~{cc_executeTool}.',
    'There are TWO kinds:',
    '• http   — wraps ONE endpoint on an integration (method + path + params).',
    '• script — runs an arbitrary Python / Node / Bash program that can install',
    '           packages, call MULTIPLE APIs, read/write files, run AI models,',
    '           convert documents, etc. Use this for anything complex or',
    '           multi-step (e.g. "PDF to Markdown" using pdfplumber + an LLM).',
    'Prefer a tool over re-deriving the call each time — it is simpler and reusable.',
    '- Search existing tools for an operation FIRST: ~{cc_searchTools} with a query',
    '  like "send calendar invite". If a match is returned, run it; if none, create one.',
    '- List every defined tool: ~{cc_listTools}',
    '- Create an HTTP tool: ~{cc_createTool} with kind="http" (default).',
    '  Provide: name, description, integrationId, method, path, and params — a',
    '  JSON ARRAY STRING where each element needs only a "key" (plus optional',
    '  location (query/body/path, default query), type, required, description).',
    '  Pass "[]" if there are no params. staticQueryParams / staticBody are optional',
    '  JSON object strings. Always pass complex fields as JSON strings, never nested objects.',
    '  Example: cc_createTool(name="List Calendar Events", integrationId="google-cal",',
    '    method="GET", path="/calendars/{calendarId}/events",',
    '    params=\'[{"key":"calendarId","location":"path","required":true},{"key":"maxResults","location":"query","type":"number"}]\')',
    '- Create a SCRIPT tool: ~{cc_createTool} with kind="script". Provide name,',
    '  description, runtime ("python"|"node"|"bash"), and code. Optionally',
    '  requirements (JSON array or comma list of packages), integrationRefs (JSON',
    '  array or comma list of integration ids whose credentials to inject), and',
    '  timeoutMs. Inside the program read inputs from the CC_TOOL_ARGS env var (JSON)',
    '  — also written to args.json — and credentials from CC_INTEGRATIONS (JSON keyed',
    '  by integration id/name, each with baseUrl + bearerToken/apiKey/secrets). Print',
    '  the result to stdout; that becomes the tool output. Declare the inputs in params.',
    '  E.g. a "PDF to Markdown" tool: runtime="python", requirements=\'["pdfplumber"]\',',
    '  params=\'[{"key":"path","required":true}]\', and code that loads the PDF and prints text.',
    '  For MULTI-FILE tools (helper modules, templates, configs) pass files — a JSON',
    '  OBJECT STRING of relativePath->contents (e.g. \'{"lib/parse.py":"def run(): ..."}\').',
    '  Files are written next to the entry point so code can import/read them; do not',
    '  use main.* or args.json as a file path.',
    '  A script tool may also COMBINE an HTTP integration with processing: reference the',
    '  integration in integrationRefs, call it inside the code using its CC_INTEGRATIONS',
    '  credentials, transform/summarise the response, then print only what the agent needs.',
    '  Set category on every tool to group related tools (e.g. "Google Calendar",',
    '  "Documents", "Sales"); reuse an existing category name shown by cc_listTools.',
    '- Update an existing tool (any field): ~{cc_updateTool}',
    '- Delete a tool: ~{cc_deleteTool}',
    '- Execute a tool by id or name, supplying the params it declares: ~{cc_executeTool}',
    '  Example: cc_executeTool(id="List Calendar Events", args={"maxResults":10})',
    '',
    'When a user asks you to connect and use a service:',
    '1. Check ~{cc_listIntegrations} — create it if missing.',
    '2. Search ~{cc_searchTools} (or list ~{cc_listTools}) for the action; create any',
    '   that are missing (an http tool for a simple call, or a script tool for',
    '   complex/multi-API/programmatic work). Set a sensible category.',
    '3. Execute with ~{cc_executeTool}.',
    'Create new tools proactively whenever a task needs a programmatic step you do not',
    'already have — do not ask the user to do it manually.',
    'When creating a new agent that will use an integration, also create the',
    'relevant tools and reference them in the agent\'s prompt so it knows what to call.',
    '',
    'When a task needs the terminal, a website, or files, call the matching tool',
    'and use its real output. Ask for confirmation only when an action is',
    'destructive or irreversible.',
].join('\n');
/**
 * Reads the Command Center environment configuration from disk and exposes a read-only,
 * secret-masked snapshot. Real secret values never leave the backend.
 */
let ConfigPlaneServiceImpl = ConfigPlaneServiceImpl_1 = class ConfigPlaneServiceImpl {
    constructor() {
        // --- OAuth 2.0 -------------------------------------------------------
        /** Transient CSRF state per integration id, set by startOAuth. */
        this.pendingOAuthState = new Map();
    }
    /**
     * Bootstrap agents and regenerate customAgents.yml (with tool refs) on
     * every backend startup so agents always have the latest tool access even
     * before the Integrations panel is opened for the first time.
     */
    init() {
        // Eagerly create the scratch workspace directory synchronously so it is
        // guaranteed to exist before any frontend RPC call resolves, regardless
        // of how quickly the async bootstrapDirectories() chain completes.
        try {
            fs.mkdirSync(path.join(this.sessionsDir, 'scratch'), { recursive: true });
        }
        catch { /* non-fatal */ }
        this.syncTheiaSettings();
    }
    async getSnapshot() {
        const resolved = this.resolveEnvFile();
        if (!resolved) {
            return { usingExample: false, sections: this.emptySections() };
        }
        const raw = await fs.promises.readFile(resolved.file, 'utf-8');
        const values = this.parseEnv(raw);
        const buckets = new Map();
        for (const def of ConfigPlaneServiceImpl_1.SECTIONS) {
            buckets.set(def.id, []);
        }
        const other = [];
        for (const [key, value] of values) {
            const entry = this.toEntry(key, value);
            const def = ConfigPlaneServiceImpl_1.SECTIONS.find(d => d.match(key));
            if (def) {
                buckets.get(def.id).push(entry);
            }
            else {
                other.push(entry);
            }
        }
        const sections = ConfigPlaneServiceImpl_1.SECTIONS.map(def => ({
            id: def.id,
            group: def.group,
            title: def.title,
            description: def.description,
            entries: buckets.get(def.id)
        }));
        // MCP servers are not env-driven yet; show an explicit placeholder section.
        sections.push({
            id: 'mcp-servers',
            group: 'mcp',
            title: 'MCP Servers',
            description: 'Registered stdio/http MCP endpoints consumed by agents.',
            entries: []
        });
        if (other.length > 0) {
            sections.push({
                id: 'other',
                group: 'other',
                title: 'Uncategorised',
                description: 'Environment variables not matched by a known group.',
                entries: other
            });
        }
        const snapshot = {
            sourceFile: resolved.file,
            usingExample: resolved.usingExample,
            sections
        };
        // Keep Theia AI settings in sync with the current .env + registry state
        this.syncTheiaSettings();
        return snapshot;
    }
    /** Walk up from the backend cwd looking for `.env`, then `.env.example`. */
    resolveEnvFile() {
        let dir = process.cwd();
        for (let i = 0; i < 6; i++) {
            const env = path.join(dir, '.env');
            if (fs.existsSync(env)) {
                return { file: env, usingExample: false };
            }
            const example = path.join(dir, '.env.example');
            if (fs.existsSync(example)) {
                return { file: example, usingExample: true };
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                break;
            }
            dir = parent;
        }
        return undefined;
    }
    /** Minimal dotenv parser: `KEY=VALUE`, ignoring comments and blank lines. */
    parseEnv(raw) {
        const out = new Map();
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }
            const eq = trimmed.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith('\'') && value.endsWith('\''))) {
                value = value.slice(1, -1);
            }
            out.set(key, value);
        }
        return out;
    }
    toEntry(key, value) {
        const secret = ConfigPlaneServiceImpl_1.SECRET_PATTERN.test(key);
        const set = value.length > 0;
        if (secret) {
            return { key, secret: true, set, length: value.length };
        }
        return { key, secret: false, set, value };
    }
    emptySections() {
        return ConfigPlaneServiceImpl_1.SECTIONS.map(def => ({
            id: def.id,
            group: def.group,
            title: def.title,
            description: def.description,
            entries: []
        }));
    }
    /** Lazily create the registry store rooted at the project directory. */
    store() {
        if (!this.storeInstance) {
            this.storeInstance = new integration_store_1.IntegrationStore(this.resolveRootDir());
        }
        return this.storeInstance;
    }
    /** Lazily create the tool store rooted at the project directory. */
    toolStore() {
        if (!this.toolStoreInstance) {
            this.toolStoreInstance = new tool_store_1.ToolStore(this.resolveRootDir());
        }
        return this.toolStoreInstance;
    }
    /** Project root = directory of the resolved `.env`, else the backend cwd. */
    resolveRootDir() {
        const resolved = this.resolveEnvFile();
        return resolved ? path.dirname(resolved.file) : process.cwd();
    }
    async getKindSpecs() {
        return integration_specs_1.INTEGRATION_KIND_SPECS;
    }
    async listIntegrations() {
        return this.store().list();
    }
    async createIntegration(draft) {
        const record = await this.store().create(draft);
        this.syncTheiaSettings();
        return record;
    }
    async updateIntegration(id, patch) {
        const record = await this.store().update(id, patch);
        this.syncTheiaSettings();
        return record;
    }
    async setIntegrationEnabled(id, enabled) {
        const record = await this.store().setEnabled(id, enabled);
        this.syncTheiaSettings();
        return record;
    }
    async deleteIntegration(id) {
        await this.store().delete(id);
        this.syncTheiaSettings();
    }
    async testIntegration(id) {
        const record = (await this.store().list()).find(r => r.id === id);
        if (!record) {
            return { ok: false, message: `No integration found with id '${id}'.` };
        }
        const secrets = await this.store().getDecryptedSecrets(id);
        try {
            switch (record.kind) {
                case 'api':
                    return await this.testApiIntegration(record, secrets);
                case 'mcp':
                    return await this.testMcpIntegration(record, secrets);
                case 'webhook':
                    return this.describeUntestable(record, 'Webhooks are validated when an event is received or sent; there is no safe automatic probe.');
                case 'infra':
                    return this.describeUntestable(record, 'Infrastructure services need their native driver to connect. Verify the host/port and credentials manually.');
                default:
                    return { ok: false, message: `Unknown integration kind '${record.kind}'.`, unsupported: true };
            }
        }
        catch (err) {
            return { ok: false, message: `Test failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
    /** Probe an API integration with an authenticated GET to its base URL. */
    async testApiIntegration(record, secrets) {
        var _a, _b;
        const baseUrl = record.values.baseUrl;
        if (!baseUrl) {
            return { ok: false, message: 'No base URL configured for this API.' };
        }
        const authType = (_a = record.values.authType) !== null && _a !== void 0 ? _a : 'none';
        const headers = { 'User-Agent': 'Command-Center/1.0' };
        if (authType === 'bearer' && secrets.apiKey) {
            headers['Authorization'] = `Bearer ${secrets.apiKey}`;
        }
        else if (authType === 'api-key-header' && secrets.apiKeyHeaderValue) {
            headers[record.values.headerName || 'X-API-Key'] = secrets.apiKeyHeaderValue;
        }
        else if (authType === 'basic' && record.values.username) {
            const basic = Buffer.from(`${record.values.username}:${(_b = secrets.password) !== null && _b !== void 0 ? _b : ''}`).toString('base64');
            headers['Authorization'] = `Basic ${basic}`;
        }
        else if (authType.startsWith('oauth2')) {
            try {
                const token = await this.ensureAccessToken(record.id);
                headers['Authorization'] = `Bearer ${token}`;
            }
            catch (err) {
                const hint = authType === 'oauth2-authorization-code'
                    ? 'Run cc_startOAuth then cc_completeOAuth to authorize, or check the client/redirect settings.'
                    : 'Check the token URL, client id and client secret.';
                return { ok: false, message: `OAuth token unavailable: ${err instanceof Error ? err.message : String(err)}. ${hint}` };
            }
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(baseUrl, { method: 'GET', headers, signal: controller.signal });
            const ok = response.status < 400;
            return {
                ok,
                status: response.status,
                message: ok
                    ? `Connected to ${baseUrl} (HTTP ${response.status}).`
                    : `Reached ${baseUrl} but got HTTP ${response.status}. Check the credentials or endpoint.`
            };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    /** Probe an HTTP-transport MCP server for reachability. stdio servers can't be probed. */
    async testMcpIntegration(record, secrets) {
        var _a;
        const transport = (_a = record.values.transport) !== null && _a !== void 0 ? _a : 'stdio';
        if (transport !== 'http') {
            const cmd = [record.values.command, record.values.args].filter(Boolean).join(' ');
            return this.describeUntestable(record, `This is a stdio MCP server (${cmd || 'no command set'}). It is launched on demand and cannot be probed without starting it.`);
        }
        const url = record.values.url;
        if (!url) {
            return { ok: false, message: 'No server URL configured for this HTTP MCP server.' };
        }
        const headers = { 'User-Agent': 'Command-Center/1.0' };
        if (secrets.token) {
            headers['Authorization'] = `Bearer ${secrets.token}`;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
            const ok = response.status < 500;
            return {
                ok,
                status: response.status,
                message: ok
                    ? `MCP endpoint ${url} is reachable (HTTP ${response.status}).`
                    : `MCP endpoint ${url} returned HTTP ${response.status}.`
            };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    describeUntestable(record, why) {
        return { ok: true, unsupported: true, message: `'${record.name}' saved. ${why}` };
    }
    async startOAuth(id) {
        const record = (await this.store().list()).find(r => r.id === id);
        if (!record) {
            throw new Error(`No integration found with id '${id}'.`);
        }
        if (record.kind !== 'api' || record.values.authType !== 'oauth2-authorization-code') {
            throw new Error("startOAuth only applies to API integrations with authType 'oauth2-authorization-code'.");
        }
        const authorizationUrl = record.values.authorizationUrl;
        const clientId = record.values.clientId;
        const redirectUri = record.values.redirectUri;
        const missing = [];
        if (!authorizationUrl) {
            missing.push('Authorization URL (authorizationUrl)');
        }
        if (!clientId) {
            missing.push('Client ID (clientId)');
        }
        if (!redirectUri) {
            missing.push('Redirect URI (redirectUri)');
        }
        if (missing.length > 0) {
            const present = Object.keys(record.values).filter(k => k !== 'authType').join(', ') || '(none)';
            throw new Error(`Cannot start OAuth for '${record.name}': missing ${missing.join(', ')}. `
                + `Set these with cc_updateIntegration (id "${id}") under "values" — `
                + `note clientId is a non-secret VALUE, only clientSecret is a secret. `
                + `Currently set values: ${present}.`);
        }
        const state = crypto.randomBytes(16).toString('hex');
        this.pendingOAuthState.set(id, state);
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUri,
            state,
        });
        if (record.values.scope) {
            params.set('scope', record.values.scope);
        }
        // Hints honoured by Google/Microsoft etc. to issue a refresh token.
        params.set('access_type', 'offline');
        params.set('prompt', 'consent');
        const sep = authorizationUrl.includes('?') ? '&' : '?';
        const fullUrl = `${authorizationUrl}${sep}${params.toString()}`;
        const instructions = '1. Open the authorization URL in a browser and sign in / approve access.\n'
            + `2. You will be redirected to ${redirectUri}. If this points at this Command Center `
            + '(host/port matches), the flow completes automatically and a success page is shown — '
            + 'no further action is needed.\n'
            + '3. If the redirect cannot reach the Command Center, copy the "code" query parameter from '
            + `the redirected URL and finish with cc_completeOAuth (id "${id}", the code, state "${state}").`;
        return { authorizationUrl: fullUrl, state, redirectUri, instructions };
    }
    async completeOAuth(id, code, state) {
        var _a, _b;
        const record = (await this.store().list()).find(r => r.id === id);
        if (!record) {
            return { ok: false, message: `No integration found with id '${id}'.` };
        }
        if (record.values.authType !== 'oauth2-authorization-code') {
            return { ok: false, message: "completeOAuth only applies to authType 'oauth2-authorization-code'." };
        }
        if (!code || !code.trim()) {
            return { ok: false, message: 'An authorization code is required.' };
        }
        const expected = this.pendingOAuthState.get(id);
        if (expected && state && expected !== state) {
            return { ok: false, message: 'OAuth state mismatch — possible CSRF. Restart with cc_startOAuth.' };
        }
        const secrets = await this.store().getDecryptedSecrets(id);
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code.trim(),
            redirect_uri: (_a = record.values.redirectUri) !== null && _a !== void 0 ? _a : '',
            client_id: (_b = record.values.clientId) !== null && _b !== void 0 ? _b : '',
        });
        if (secrets.clientSecret) {
            body.set('client_secret', secrets.clientSecret);
        }
        try {
            const result = await this.exchangeToken(record, body);
            if (result.ok) {
                this.pendingOAuthState.delete(id);
            }
            return result;
        }
        catch (err) {
            return { ok: false, message: `Token exchange failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
    /**
     * Resolve a redirect callback by its CSRF `state`: find the integration that
     * started this OAuth flow and exchange the authorization `code` for tokens.
     * Used by the backend /oauth/callback HTTP route so the browser redirect from
     * the provider completes the flow automatically (no manual code copying).
     */
    async completeOAuthByState(code, state) {
        if (!state) {
            return { result: { ok: false, message: 'Missing OAuth state in callback.' } };
        }
        let matchedId;
        for (const [id, expected] of this.pendingOAuthState.entries()) {
            if (expected === state) {
                matchedId = id;
                break;
            }
        }
        if (!matchedId) {
            return { result: { ok: false, message: 'No pending OAuth flow matches this state. It may have expired — restart with cc_startOAuth.' } };
        }
        const record = (await this.store().list()).find(r => r.id === matchedId);
        const result = await this.completeOAuth(matchedId, code, state);
        return { result, integrationName: record === null || record === void 0 ? void 0 : record.name };
    }
    async refreshOAuthToken(id) {
        var _a, _b, _c;
        const record = (await this.store().list()).find(r => r.id === id);
        if (!record) {
            return { ok: false, message: `No integration found with id '${id}'.` };
        }
        const authType = (_a = record.values.authType) !== null && _a !== void 0 ? _a : '';
        const secrets = await this.store().getDecryptedSecrets(id);
        let body;
        if (authType === 'oauth2-client-credentials') {
            body = new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: (_b = record.values.clientId) !== null && _b !== void 0 ? _b : '',
            });
            if (secrets.clientSecret) {
                body.set('client_secret', secrets.clientSecret);
            }
            if (record.values.scope) {
                body.set('scope', record.values.scope);
            }
        }
        else if (authType === 'oauth2-authorization-code') {
            if (!secrets.refreshToken) {
                return { ok: false, message: 'No refresh token stored. Run cc_startOAuth then cc_completeOAuth first.' };
            }
            body = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: secrets.refreshToken,
                client_id: (_c = record.values.clientId) !== null && _c !== void 0 ? _c : '',
            });
            if (secrets.clientSecret) {
                body.set('client_secret', secrets.clientSecret);
            }
            if (record.values.scope) {
                body.set('scope', record.values.scope);
            }
        }
        else {
            return { ok: false, message: `Integration '${record.name}' is not an OAuth integration.` };
        }
        try {
            return await this.exchangeToken(record, body);
        }
        catch (err) {
            return { ok: false, message: `Token request failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
    /**
     * POST an x-www-form-urlencoded token request to the integration's token URL,
     * persist the returned access/refresh tokens (encrypted) and expiry, and
     * return a structured result. Shared by the exchange and refresh paths.
     */
    async exchangeToken(record, body) {
        var _a, _b, _c;
        const tokenUrl = record.values.tokenUrl;
        if (!tokenUrl) {
            return { ok: false, message: 'No token URL configured for this integration.' };
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let response;
        let text;
        try {
            response = await fetch(tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                    'User-Agent': 'Command-Center/1.0',
                },
                body: body.toString(),
                signal: controller.signal,
            });
            text = await response.text();
        }
        finally {
            clearTimeout(timeout);
        }
        let parsed = {};
        try {
            parsed = text ? JSON.parse(text) : {};
        }
        catch { /* non-JSON body */ }
        if (!response.ok) {
            const detail = (_c = (_b = (_a = parsed.error_description) !== null && _a !== void 0 ? _a : parsed.error) !== null && _b !== void 0 ? _b : text) !== null && _c !== void 0 ? _c : `HTTP ${response.status}`;
            return { ok: false, status: response.status, message: `Provider rejected token request (HTTP ${response.status}): ${String(detail)}` };
        }
        const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : undefined;
        if (!accessToken) {
            return { ok: false, status: response.status, message: 'Token endpoint did not return an access_token.' };
        }
        const refreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined;
        const expiresInRaw = parsed.expires_in;
        const expiresIn = typeof expiresInRaw === 'number' ? expiresInRaw
            : (typeof expiresInRaw === 'string' ? parseInt(expiresInRaw, 10) : NaN);
        const expiresAt = !Number.isNaN(expiresIn)
            ? new Date(Date.now() + expiresIn * 1000).toISOString()
            : undefined;
        const scope = typeof parsed.scope === 'string' ? parsed.scope : undefined;
        // Persist tokens (encrypted) and expiry, preserving all other values.
        const secretsPatch = { accessToken };
        if (refreshToken) {
            secretsPatch.refreshToken = refreshToken;
        }
        await this.store().update(record.id, {
            values: { ...record.values, ...(expiresAt ? { tokenExpiresAt: expiresAt } : {}) },
            secrets: secretsPatch,
        });
        this.syncTheiaSettings();
        const hadRefresh = !!refreshToken;
        return {
            ok: true,
            status: response.status,
            expiresAt,
            scope,
            hasRefreshToken: hadRefresh || record.secretsSet.includes('refreshToken'),
            message: `Access token stored${expiresAt ? ` (expires ${expiresAt})` : ''}.`
                + `${hadRefresh ? ' Refresh token saved for silent renewal.' : ''}`,
        };
    }
    async callIntegration(id, method, path_, params, body, extraHeaders) {
        var _a, _b, _c;
        const MAX_BODY = 32768; // characters — safe for most LLM context windows
        const record = (await this.store().list()).find(r => r.id === id);
        if (!record) {
            return { ok: false, status: 0, body: '', error: `No integration found with id '${id}'.` };
        }
        if (record.kind !== 'api') {
            return { ok: false, status: 0, body: '', error: `Integration '${record.name}' is not an API integration.` };
        }
        // Build the full URL: absolute path_ overrides baseUrl, relative is appended.
        let url;
        if (/^https?:\/\//i.test(path_)) {
            url = path_;
        }
        else {
            const base = ((_a = record.values.baseUrl) !== null && _a !== void 0 ? _a : '').replace(/\/$/, '');
            const rel = path_.startsWith('/') ? path_ : `/${path_}`;
            url = `${base}${rel}`;
        }
        if (params && Object.keys(params).length > 0) {
            const qs = new URLSearchParams(params).toString();
            url += (url.includes('?') ? '&' : '?') + qs;
        }
        // Resolve auth headers from stored credentials.
        const authType = (_b = record.values.authType) !== null && _b !== void 0 ? _b : 'none';
        const secrets = await this.store().getDecryptedSecrets(id);
        const headers = {
            'User-Agent': 'Command-Center/1.0',
            'Accept': 'application/json',
            ...extraHeaders,
        };
        if (authType === 'bearer' && secrets.apiKey) {
            headers['Authorization'] = `Bearer ${secrets.apiKey}`;
        }
        else if (authType === 'api-key-header' && secrets.apiKeyHeaderValue) {
            headers[record.values.headerName || 'X-API-Key'] = secrets.apiKeyHeaderValue;
        }
        else if (authType === 'basic' && record.values.username) {
            const basic = Buffer.from(`${record.values.username}:${(_c = secrets.password) !== null && _c !== void 0 ? _c : ''}`).toString('base64');
            headers['Authorization'] = `Basic ${basic}`;
        }
        else if (authType.startsWith('oauth2')) {
            try {
                const token = await this.ensureAccessToken(id);
                headers['Authorization'] = `Bearer ${token}`;
            }
            catch (err) {
                return { ok: false, status: 0, body: '', error: `OAuth token unavailable: ${err instanceof Error ? err.message : String(err)}` };
            }
        }
        // Serialize the request body.
        let requestBody;
        let contentType;
        if (body !== undefined && body !== null) {
            if (typeof body === 'string') {
                requestBody = body;
                contentType = 'text/plain';
            }
            else {
                requestBody = JSON.stringify(body);
                contentType = 'application/json';
            }
            if (!headers['Content-Type']) {
                headers['Content-Type'] = contentType;
            }
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(url, {
                method: method.toUpperCase(),
                headers,
                body: requestBody,
                signal: controller.signal,
            });
            const text = await response.text();
            const truncated = text.length > MAX_BODY;
            return {
                ok: response.status < 400,
                status: response.status,
                body: truncated ? text.slice(0, MAX_BODY) : text,
                truncated,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, status: 0, body: '', error: msg };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    /**
     * Return a currently-valid bearer access token for an OAuth API integration,
     * transparently refreshing it when missing or within 60s of expiry. Throws
     * when no token can be obtained (e.g. authorization-code flow not completed).
     */
    async ensureAccessToken(id) {
        const record = (await this.store().list()).find(r => r.id === id);
        if (!record) {
            throw new Error(`No integration found with id '${id}'.`);
        }
        const secrets = await this.store().getDecryptedSecrets(id);
        const expiresAt = record.values.tokenExpiresAt ? Date.parse(record.values.tokenExpiresAt) : NaN;
        const stillValid = !!secrets.accessToken && (Number.isNaN(expiresAt) || expiresAt - Date.now() > 60000);
        if (stillValid) {
            return secrets.accessToken;
        }
        const refreshed = await this.refreshOAuthToken(id);
        if (!refreshed.ok) {
            if (secrets.accessToken) {
                // Fall back to the stored token when a refresh isn't possible.
                return secrets.accessToken;
            }
            throw new Error(refreshed.message);
        }
        const after = await this.store().getDecryptedSecrets(id);
        if (!after.accessToken) {
            throw new Error('No access token available after refresh.');
        }
        return after.accessToken;
    }
    // --- Skills ----------------------------------------------------------
    /** Directories scanned for SKILL.md files, in priority order. */
    skillDirs() {
        const root = this.resolveRootDir();
        return [
            path.join(os.homedir(), '.theia', 'skills'),
            path.join(root, 'skills'),
            path.join(root, 'level4', 'skills')
        ];
    }
    async listSkills() {
        const byName = new Map();
        for (const dir of this.skillDirs()) {
            for (const file of this.findSkillFiles(dir)) {
                try {
                    const raw = await fs.promises.readFile(file, 'utf-8');
                    const summary = this.parseSkillSummary(raw, file);
                    if (summary && !byName.has(summary.name)) {
                        // Statically scan the skill body so the UI can warn before
                        // an agent is granted a potentially unsafe skill.
                        summary.safety = (0, agent_intelligence_1.scanSkillContent)(this.stripFrontmatter(raw));
                        byName.set(summary.name, summary);
                    }
                }
                catch { /* skip unreadable skill */ }
            }
        }
        return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
    async getSkill(name) {
        for (const dir of this.skillDirs()) {
            for (const file of this.findSkillFiles(dir)) {
                try {
                    const raw = await fs.promises.readFile(file, 'utf-8');
                    const summary = this.parseSkillSummary(raw, file);
                    if (summary && summary.name === name) {
                        return this.stripFrontmatter(raw);
                    }
                }
                catch { /* skip */ }
            }
        }
        throw new Error(`Skill '${name}' not found.`);
    }
    async scanSkill(name) {
        const body = await this.getSkill(name);
        return (0, agent_intelligence_1.scanSkillContent)(body);
    }
    /** Absolute path to the writable user skills directory (~/.theia/skills). */
    get userSkillsDir() {
        return path.join(os.homedir(), '.theia', 'skills');
    }
    async writeSkill(draft) {
        var _a, _b, _c, _d;
        const name = this.agentId(draft.name);
        if (!name) {
            throw new Error('Cannot derive a skill id from the given name.');
        }
        if (!((_a = draft.description) === null || _a === void 0 ? void 0 : _a.trim())) {
            throw new Error('A skill description is required.');
        }
        if (!((_b = draft.body) === null || _b === void 0 ? void 0 : _b.trim())) {
            throw new Error('A skill body is required.');
        }
        const domain = draft.domain ? this.agentId(draft.domain) : undefined;
        const skillFolder = domain
            ? path.join(this.userSkillsDir, domain, name)
            : path.join(this.userSkillsDir, name);
        await fs.promises.mkdir(skillFolder, { recursive: true });
        // Assemble YAML frontmatter. Values are quoted to stay valid YAML.
        const esc = (s) => s.replace(/"/g, '\\"');
        const fm = ['---', `name: ${name}`, `description: "${esc(draft.description.trim())}"`];
        if ((_c = draft.whenToUse) === null || _c === void 0 ? void 0 : _c.trim()) {
            fm.push(`when_to_use: "${esc(draft.whenToUse.trim())}"`);
        }
        if ((_d = draft.allowedTools) === null || _d === void 0 ? void 0 : _d.length) {
            fm.push(`allowed_tools: [${draft.allowedTools.map(t => `"${esc(t)}"`).join(', ')}]`);
        }
        fm.push('---', '');
        const content = fm.join('\n') + '\n' + draft.body.trim() + '\n';
        const filePath = path.join(skillFolder, 'SKILL.md');
        await fs.promises.writeFile(filePath, content, 'utf-8');
        const summary = this.parseSkillSummary(content, filePath);
        if (!summary) {
            throw new Error('Skill was written but could not be parsed back — check the frontmatter.');
        }
        summary.safety = (0, agent_intelligence_1.scanSkillContent)(this.stripFrontmatter(content));
        // Refresh the cache used during prompt regeneration.
        this.cachedSkills = await this.listSkills();
        return summary;
    }
    async deleteSkill(name) {
        const target = this.agentId(name);
        // Only user skills (under ~/.theia/skills) are deletable; repo skills are read-only.
        for (const file of this.findSkillFiles(this.userSkillsDir)) {
            try {
                const raw = await fs.promises.readFile(file, 'utf-8');
                const summary = this.parseSkillSummary(raw, file);
                if (summary && summary.name === target) {
                    // Remove the whole skill folder containing this SKILL.md.
                    await fs.promises.rm(path.dirname(file), { recursive: true, force: true });
                    this.cachedSkills = await this.listSkills();
                    return;
                }
            }
            catch { /* skip */ }
        }
        throw new Error(`User skill '${name}' not found (repo-bundled skills cannot be deleted).`);
    }
    /** Recursively collect SKILL.md paths under a directory (depth-limited). */
    findSkillFiles(dir, depth = 0) {
        if (depth > 4 || !fs.existsSync(dir)) {
            return [];
        }
        const out = [];
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return [];
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                out.push(...this.findSkillFiles(full, depth + 1));
            }
            else if (entry.name === 'SKILL.md') {
                out.push(full);
            }
        }
        return out;
    }
    /** Parse the YAML frontmatter of a SKILL.md into a {@link SkillSummary}. */
    parseSkillSummary(raw, source) {
        var _a;
        const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw);
        if (!match) {
            return undefined;
        }
        const fm = this.parseSimpleYaml(match[1]);
        const name = fm.get('name');
        const description = fm.get('description');
        if (!name || !description) {
            return undefined;
        }
        const allowedRaw = fm.get('allowed_tools');
        const allowedTools = allowedRaw
            ? allowedRaw.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
            : undefined;
        // Domain = the folder directly under a "skills" directory, if any.
        const parts = source.split(/[\\/]/);
        const skillsIdx = parts.lastIndexOf('skills');
        const domain = skillsIdx >= 0 && parts.length - skillsIdx > 3 ? parts[skillsIdx + 1] : undefined;
        return {
            name: name.replace(/^['"]|['"]$/g, ''),
            description: description.replace(/^['"]|['"]$/g, ''),
            whenToUse: (_a = fm.get('when_to_use')) === null || _a === void 0 ? void 0 : _a.replace(/^['"]|['"]$/g, ''),
            domain,
            allowedTools: allowedTools && allowedTools.length ? allowedTools : undefined,
            source
        };
    }
    /** Minimal flat-YAML parser for `key: value` frontmatter lines. */
    parseSimpleYaml(block) {
        const out = new Map();
        for (const line of block.split(/\r?\n/)) {
            // Skip blank lines, comments, and indented (nested) lines.
            if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) {
                continue;
            }
            const colon = line.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            const key = line.slice(0, colon).trim();
            const value = line.slice(colon + 1).trim();
            if (key && !out.has(key)) {
                out.set(key, value);
            }
        }
        return out;
    }
    /** Remove the leading `--- ... ---` frontmatter block from a SKILL.md. */
    stripFrontmatter(raw) {
        return raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
    }
    /** Directory where individual agent JSON definitions are stored. */
    get agentsDir() {
        return path.join(os.homedir(), '.theia', 'agents');
    }
    /** Directory where workspace sessions are stored.
     *  On Windows → ~/Documents/CommandCenter; elsewhere → ~/CommandCenter.
     *  This keeps sessions visible in the user's Documents folder rather
     *  than buried in a hidden app-data directory.
     */
    get sessionsDir() {
        const base = process.platform === 'win32'
            ? path.join(os.homedir(), 'Documents', 'CommandCenter')
            : path.join(os.homedir(), 'CommandCenter');
        return base;
    }
    /** Directory where user-authored workflow YAML/JSON specs are stored. */
    get workflowsDir() {
        return path.join(os.homedir(), '.theia', 'workflows');
    }
    /** Slugify a display name to a valid agent id. */
    agentId(name) {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/, '');
    }
    // --- Agent management ------------------------------------------------
    async listAgents() {
        await fs.promises.mkdir(this.agentsDir, { recursive: true });
        let files;
        try {
            files = await fs.promises.readdir(this.agentsDir);
        }
        catch {
            return [];
        }
        const agents = [];
        for (const file of files.filter(f => f.endsWith('.json'))) {
            try {
                const raw = await fs.promises.readFile(path.join(this.agentsDir, file), 'utf-8');
                agents.push(JSON.parse(raw));
            }
            catch { /* skip malformed */ }
        }
        return agents.sort((a, b) => {
            if (a.id === 'agent-creator') {
                return -1;
            }
            if (b.id === 'agent-creator') {
                return 1;
            }
            if (a.id === 'assistant') {
                return -1;
            }
            if (b.id === 'assistant') {
                return 1;
            }
            return a.name.localeCompare(b.name);
        });
    }
    async createAgent(draft) {
        var _a, _b, _c, _d, _e, _f;
        const id = (_a = draft.id) !== null && _a !== void 0 ? _a : this.agentId(draft.name);
        if (!id) {
            throw new Error('Cannot derive agent ID from the given name.');
        }
        const agent = {
            id,
            name: draft.name,
            description: draft.description,
            prompt: draft.prompt,
            defaultLLM: (_b = draft.defaultLLM) !== null && _b !== void 0 ? _b : 'google/gemini-2.5-flash',
            showInChat: (_c = draft.showInChat) !== null && _c !== void 0 ? _c : true,
            ...(draft.workspaceBinding ? { workspaceBinding: draft.workspaceBinding } : {}),
            ...(((_d = draft.skills) === null || _d === void 0 ? void 0 : _d.length) ? { skills: draft.skills } : {}),
            ...(((_e = draft.tools) === null || _e === void 0 ? void 0 : _e.length) ? { tools: draft.tools } : {}),
            ...(draft.soul ? { soul: draft.soul } : {}),
            directives: (_f = draft.directives) !== null && _f !== void 0 ? _f : [],
            promptVersion: 1,
        };
        await fs.promises.mkdir(this.agentsDir, { recursive: true });
        await fs.promises.writeFile(path.join(this.agentsDir, `${id}.json`), JSON.stringify(agent, undefined, 2), 'utf-8');
        await this.regenerateCustomAgentsYaml();
        return agent;
    }
    async updateAgent(id, patch) {
        var _a, _b, _c;
        const agents = await this.listAgents();
        const existing = agents.find(a => a.id === id);
        if (!existing) {
            throw new Error(`Agent '${id}' not found.`);
        }
        // Snapshot prompt history when the authored text changes.
        let promptHistory = (_a = existing.promptHistory) !== null && _a !== void 0 ? _a : [];
        let promptVersion = (_b = existing.promptVersion) !== null && _b !== void 0 ? _b : 1;
        if (patch.prompt !== undefined && patch.prompt !== existing.prompt) {
            promptHistory = [
                ...promptHistory,
                {
                    version: promptVersion,
                    prompt: existing.prompt,
                    directives: (_c = existing.directives) !== null && _c !== void 0 ? _c : [],
                    changedAt: new Date().toISOString(),
                },
            ].slice(-10); // keep last 10 snapshots
            promptVersion += 1;
        }
        const updated = {
            ...existing,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
            ...(patch.defaultLLM !== undefined ? { defaultLLM: patch.defaultLLM } : {}),
            ...(patch.showInChat !== undefined ? { showInChat: patch.showInChat } : {}),
            ...(patch.workspaceBinding !== undefined ? { workspaceBinding: patch.workspaceBinding } : {}),
            ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
            ...(patch.tools !== undefined ? { tools: patch.tools } : {}),
            ...(patch.soul !== undefined ? { soul: patch.soul } : {}),
            ...(patch.directives !== undefined ? { directives: patch.directives } : {}),
            promptVersion,
            promptHistory,
        };
        await fs.promises.writeFile(path.join(this.agentsDir, `${id}.json`), JSON.stringify(updated, undefined, 2), 'utf-8');
        await this.regenerateCustomAgentsYaml();
        return updated;
    }
    async deleteAgent(id) {
        if (ConfigPlaneServiceImpl_1.BUILTIN_AGENT_IDS.has(id)) {
            throw new Error(`Built-in agent '${id}' cannot be deleted.`);
        }
        const filePath = path.join(this.agentsDir, `${id}.json`);
        await fs.promises.unlink(filePath).catch(() => { });
        await this.regenerateCustomAgentsYaml();
    }
    // --- Agent directives -----------------------------------------------
    async loadAgent(agentId) {
        const filePath = path.join(this.agentsDir, `${agentId}.json`);
        try {
            const raw = await fs.promises.readFile(filePath, 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            throw new Error(`Agent '${agentId}' not found.`);
        }
    }
    directiveId() {
        return `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    async addDirective(agentId, text, source = 'manual') {
        var _a;
        const agent = await this.loadAgent(agentId);
        const directive = {
            id: this.directiveId(),
            text: text.trim(),
            source,
            addedAt: new Date().toISOString(),
            // Manual directives are immediately active; Reflector proposals start pending.
            status: source === 'manual' ? 'active' : 'pending',
        };
        const directives = [...((_a = agent.directives) !== null && _a !== void 0 ? _a : []), directive];
        await this.updateAgent(agentId, { directives });
        return directive;
    }
    async updateDirective(agentId, directiveId, text) {
        var _a;
        const agent = await this.loadAgent(agentId);
        const directives = ((_a = agent.directives) !== null && _a !== void 0 ? _a : []).map(d => d.id === directiveId ? { ...d, text: text.trim(), evalScore: undefined } : d);
        if (!directives.find(d => d.id === directiveId)) {
            throw new Error(`Directive '${directiveId}' not found on agent '${agentId}'.`);
        }
        await this.updateAgent(agentId, { directives });
        return directives.find(d => d.id === directiveId);
    }
    async removeDirective(agentId, directiveId) {
        var _a;
        const agent = await this.loadAgent(agentId);
        const directives = ((_a = agent.directives) !== null && _a !== void 0 ? _a : []).filter(d => d.id !== directiveId);
        await this.updateAgent(agentId, { directives });
    }
    async approveDirective(agentId, directiveId) {
        var _a;
        const agent = await this.loadAgent(agentId);
        const directives = ((_a = agent.directives) !== null && _a !== void 0 ? _a : []).map(d => d.id === directiveId ? { ...d, status: 'active' } : d);
        await this.updateAgent(agentId, { directives });
        const found = directives.find(d => d.id === directiveId);
        if (!found) {
            throw new Error(`Directive '${directiveId}' not found.`);
        }
        return found;
    }
    async rejectDirective(agentId, directiveId) {
        var _a;
        const agent = await this.loadAgent(agentId);
        const directives = ((_a = agent.directives) !== null && _a !== void 0 ? _a : []).map(d => d.id === directiveId ? { ...d, status: 'rejected' } : d);
        await this.updateAgent(agentId, { directives });
        const found = directives.find(d => d.id === directiveId);
        if (!found) {
            throw new Error(`Directive '${directiveId}' not found.`);
        }
        return found;
    }
    // --- Feedback -------------------------------------------------------
    async recordFeedback(agentId, signal, note, conversationId) {
        const entry = {
            id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            agentId,
            signal,
            ...(note ? { note } : {}),
            ...(conversationId ? { conversationId } : {}),
            createdAt: new Date().toISOString(),
        };
        const feedbackPath = path.join(this.agentsDir, `${agentId}.feedback.jsonl`);
        await fs.promises.appendFile(feedbackPath, JSON.stringify(entry) + '\n', 'utf-8');
    }
    async listFeedback(agentId) {
        const feedbackPath = path.join(this.agentsDir, `${agentId}.feedback.jsonl`);
        try {
            const raw = await fs.promises.readFile(feedbackPath, 'utf-8');
            return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
        }
        catch {
            return [];
        }
    }
    async getAgentTrust(agentId) {
        const feedback = await this.listFeedback(agentId);
        return (0, agent_intelligence_1.computeTrustScore)(feedback);
    }
    // --- Agent bootstrap + YAML generation --------------------------------
    /**
     * Ensures ~/.theia/agents/ contains the built-in agent JSON definitions
     * (assistant + agent-creator + reflector).  Missing definitions are created;
     * existing ones have their canonical prompt/description refreshed to the
     * latest shipped version *unless the user has manually edited the prompt*
     * (detected via promptVersion > 1 or a recorded promptHistory), so software
     * upgrades reach built-in agents without clobbering user customisations.
     */
    async bootstrapAgents() {
        await fs.promises.mkdir(this.agentsDir, { recursive: true });
        const assistantPrompt = [
            '# Role',
            'You are the Command Center assistant, an intelligent AI assistant built into the Command Center platform.',
            'Be helpful, concise, and accurate.',
            'When tools are available to you (such as Google Calendar), use them proactively to answer questions.',
            '',
            '## Current Context',
            '{{contextDetails}}',
        ].join('\n');
        await this.ensureBuiltinAgent({
            id: 'assistant',
            name: 'Assistant',
            description: 'Command Center AI assistant — answers questions, helps with tasks, and can use connected tools like Google Calendar.',
            prompt: assistantPrompt,
            defaultLLM: 'google/gemini-2.5-flash',
            showInChat: true,
            builtin: true,
        });
        await this.ensureBuiltinAgent({
            id: 'agent-creator',
            name: 'Agent Creator',
            description: "Designs and creates specialized AI agents using Anthropic's agent building principles.",
            prompt: AGENT_CREATOR_PROMPT,
            defaultLLM: 'google/gemini-2.5-flash',
            showInChat: true,
            builtin: true,
        });
        await this.ensureBuiltinAgent({
            id: 'reflector',
            name: 'Reflector',
            description: 'Analyses agent feedback and proposes standing directive improvements. Not shown in the chat list — invoke via "Reflect on agent…" in the Agents panel.',
            prompt: REFLECTOR_PROMPT,
            // Hidden from the main chat list; invoked programmatically from the Agents panel.
            showInChat: false,
            defaultLLM: 'google/gemini-2.5-flash',
            builtin: true,
        });
    }
    /**
     * Create a built-in agent if absent, or refresh its shipped prompt and
     * description when the user has not manually edited it. User-owned fields
     * (soul, directives, skills, defaultLLM, showInChat, prompt history) are
     * always preserved.
     */
    async ensureBuiltinAgent(def) {
        var _a, _b, _c;
        const filePath = path.join(this.agentsDir, `${def.id}.json`);
        if (!fs.existsSync(filePath)) {
            await fs.promises.writeFile(filePath, JSON.stringify(def, undefined, 2), 'utf-8');
            return;
        }
        let existing;
        try {
            existing = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
        }
        catch {
            // Corrupt file — overwrite with the canonical definition.
            await fs.promises.writeFile(filePath, JSON.stringify(def, undefined, 2), 'utf-8');
            return;
        }
        // Treat the prompt as user-edited once it has been versioned past 1 or
        // has any recorded history; in that case leave the prompt untouched.
        const userEdited = ((_a = existing.promptVersion) !== null && _a !== void 0 ? _a : 1) > 1
            || ((_c = (_b = existing.promptHistory) === null || _b === void 0 ? void 0 : _b.length) !== null && _c !== void 0 ? _c : 0) > 0;
        const needsRefresh = !userEdited
            && (existing.prompt !== def.prompt || existing.description !== def.description);
        if (!needsRefresh) {
            return;
        }
        const refreshed = {
            ...existing,
            name: def.name,
            description: def.description,
            prompt: def.prompt,
            builtin: true,
        };
        await fs.promises.writeFile(filePath, JSON.stringify(refreshed, undefined, 2), 'utf-8');
    }
    /**
     * Serialises one agent definition to a YAML block entry suitable for
     * customAgents.yml.  Strings containing YAML special characters are
     * double-quoted.
     */
    agentToYamlBlock(agent) {
        const safeStr = (s) => {
            if (/[:#{}\[\],|>&*?!'"\\@`]|^\s|\s$/.test(s)) {
                return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
            }
            return s;
        };
        const lines = [
            `- id: ${agent.id}`,
            `  name: ${safeStr(agent.name)}`,
            `  description: ${safeStr(agent.description)}`,
            `  showInChat: ${agent.showInChat}`,
            `  defaultLLM: ${agent.defaultLLM}`,
            `  prompt: |`,
        ];
        // Compose the final prompt: soul context, the agent's own prompt, optional
        // directives, optional skills block, then the standard tool-access block.
        const promptWithExtras = [
            agent.prompt,
            this.soulPromptSection(agent),
            this.directivesPromptSection(agent),
            this.skillsPromptSection(agent),
            this.toolsPromptSection(agent),
            TOOL_BLOCK
        ].filter(Boolean).join('\n');
        for (const line of promptWithExtras.split('\n')) {
            lines.push(`    ${line}`);
        }
        lines.push('');
        return lines.join('\n');
    }
    /**
     * Build an Identity/Soul section from the agent's `soul` field, if present.
     * Compiled into the prompt header to ground the LLM's persona.
     */
    soulPromptSection(agent) {
        var _a;
        const soul = agent.soul;
        if (!soul) {
            return '';
        }
        const lines = ['', '## Identity'];
        if (soul.role) {
            lines.push(`**Role**: ${soul.role}`);
        }
        if (soul.domain) {
            lines.push(`**Domain**: ${soul.domain}`);
        }
        if (soul.persona) {
            lines.push(`**Persona**: ${soul.persona}`);
        }
        if ((_a = soul.coreValues) === null || _a === void 0 ? void 0 : _a.length) {
            lines.push('', '**Core Values**');
            for (const v of soul.coreValues) {
                lines.push(`- ${v}`);
            }
        }
        return lines.join('\n');
    }
    /**
     * Build a "Standing Directives" section from active directives.
     * These are injected between the authored prompt and the skill/tool block
     * so they constrain the LLM's behaviour on every response.
     */
    directivesPromptSection(agent) {
        var _a;
        const { selected, omittedCount } = (0, agent_intelligence_1.selectDirectivesForPrompt)((_a = agent.directives) !== null && _a !== void 0 ? _a : [], { soul: agent.soul, description: agent.description });
        if (selected.length === 0) {
            return '';
        }
        const lines = [
            '',
            '## Standing Directives',
            'These rules are permanent constraints on your behaviour.',
            'Follow every applicable directive on every response without exception.',
            '',
        ];
        for (const d of selected) {
            lines.push(`- ${d.text}`);
        }
        if (omittedCount > 0) {
            lines.push('', `_(${omittedCount} additional lower-priority directive${omittedCount === 1 ? '' : 's'} ` +
                'omitted to keep this prompt focused; the most relevant ones are listed above.)_');
        }
        return lines.join('\n');
    }
    /**
     * Build a "Your Skills" prompt section for an agent that has skills
     * assigned. Lists each skill's name, description and when-to-use guidance,
     * and instructs the agent to load full instructions on demand via the
     * `cc_useSkill` tool. Returns '' when the agent has no assigned skills.
     */
    skillsPromptSection(agent) {
        var _a, _b;
        const assigned = (_a = agent.skills) !== null && _a !== void 0 ? _a : [];
        if (assigned.length === 0) {
            return '';
        }
        const summaries = (_b = this.cachedSkills) !== null && _b !== void 0 ? _b : [];
        const lines = [
            '',
            '## Your Skills',
            'You have been granted the following skills. A skill is a reusable',
            'procedure with detailed steps. When a request matches a skill\'s',
            'purpose, load its full instructions with ~{cc_useSkill} (pass the',
            'skill name) and follow them precisely.',
            ''
        ];
        for (const name of assigned) {
            const skill = summaries.find(s => s.name === name);
            if (skill) {
                const when = skill.whenToUse ? ` — use when: ${skill.whenToUse}` : '';
                lines.push(`- **${skill.name}**: ${skill.description}${when}`);
            }
            else {
                lines.push(`- **${name}** (load with ~{cc_useSkill})`);
            }
        }
        return lines.join('\n');
    }
    /**
     * Build a "Your Tools" prompt section for an agent that has user-defined
     * tools (integration wrappers) assigned. Lists each tool's name, what it
     * does and the integration it calls, and instructs the agent to invoke it
     * with ~{cc_executeTool}. Returns '' when the agent has no assigned tools.
     */
    toolsPromptSection(agent) {
        var _a, _b, _c, _d, _e;
        const assigned = (_a = agent.tools) !== null && _a !== void 0 ? _a : [];
        if (assigned.length === 0) {
            return '';
        }
        const defs = (_b = this.cachedToolDefs) !== null && _b !== void 0 ? _b : [];
        const lines = [
            '',
            '## Your Tools',
            'You have been granted the following integration tools. Call them with',
            '~{cc_executeTool} using the tool **name** shown below (or the UUID id —',
            'both work). Supply an `args` object whose keys match the declared parameters.',
            'Use ~{cc_listTools} to inspect a tool\'s full parameter list before calling it.',
            ''
        ];
        for (const name of assigned) {
            const tool = defs.find(t => t.name === name || t.id === name);
            if (tool) {
                const state = tool.enabled === false ? ' ⚠ disabled' : '';
                const paramList = tool.params.length > 0
                    ? ` — params: ${tool.params.map(p => `${p.key}(${p.location}${p.required ? ',required' : ''})`).join(', ')}`
                    : '';
                const backing = ((_c = tool.kind) !== null && _c !== void 0 ? _c : 'http') === 'script'
                    ? `[${(_d = tool.runtime) !== null && _d !== void 0 ? _d : 'python'} script]`
                    : `[${(_e = tool.method) !== null && _e !== void 0 ? _e : 'GET'} via integration ${tool.integrationId}]`;
                lines.push(`- **"${tool.name}"**${state}: ${tool.description}${paramList} ${backing}`);
            }
            else {
                lines.push(`- **"${name}"** (call with ~{cc_executeTool})`);
            }
        }
        return lines.join('\n');
    }
    /**
     * Regenerates ~/.theia/prompt-templates/customAgents.yml from the agent
     * JSON files in ~/.theia/agents/.  Called after every agent mutation and
     * on startup via bootstrapAgents.
     */
    async regenerateCustomAgentsYaml() {
        const agents = await this.listAgents();
        // Cache discovered skills so the synchronous agentToYamlBlock can
        // resolve assigned skill summaries without async calls per agent.
        this.cachedSkills = await this.listSkills();
        // Cache user-defined tools so toolsPromptSection can resolve assigned
        // tool definitions synchronously per agent.
        this.cachedToolDefs = await this.listTools().catch(() => []);
        const templatesDir = path.join(os.homedir(), '.theia', 'prompt-templates');
        await fs.promises.mkdir(templatesDir, { recursive: true });
        // Register ALL agents (including hidden meta-agents like the Reflector)
        // so they exist and can be switched to programmatically. Hiding from the
        // chat picker is handled in the frontend, not by omitting from the YAML —
        // omitting here caused "agent does not exist or is disabled" warnings.
        const yaml = agents
            .map(a => this.agentToYamlBlock(a))
            .join('\n');
        const yamlPath = path.join(templatesDir, 'customAgents.yml');
        await fs.promises.writeFile(yamlPath, yaml, 'utf-8');
    }
    /**
     * Writes LLM provider keys from `.env` and enabled MCP servers from the
     * integration store into `~/.theia/settings.json` so that Theia AI
     * automatically picks them up.  Called on startup and after every CRUD
     * mutation — errors are non-fatal and only logged.
     */
    syncTheiaSettings() {
        this.doSyncTheiaSettings().catch(e => console.warn('[cc] Theia settings sync failed:', e));
    }
    async doSyncTheiaSettings() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        const settingsPath = path.join(os.homedir(), '.theia', 'settings.json');
        // 0. Bootstrap built-in agents, directories, and regenerate customAgents.yml
        await this.bootstrapDirectories();
        await this.bootstrapAgents();
        await this.regenerateCustomAgentsYaml();
        // 1. Load existing settings (preserve any keys we do not own)
        let settings = {};
        try {
            const raw = await fs.promises.readFile(settingsPath, 'utf-8');
            settings = JSON.parse(raw);
        }
        catch { /* start fresh */ }
        // 2. Sync LLM keys from .env ----------------------------------------
        const resolved = this.resolveEnvFile();
        if (resolved) {
            const raw = await fs.promises.readFile(resolved.file, 'utf-8');
            const values = this.parseEnv(raw);
            // OpenAI official
            const openaiKey = (_a = values.get('OPENAI_API_KEY')) !== null && _a !== void 0 ? _a : '';
            if (openaiKey) {
                settings['ai-features.openAiOfficial.openAiApiKey'] = openaiKey;
            }
            else {
                delete settings['ai-features.openAiOfficial.openAiApiKey'];
            }
            // Anthropic
            const anthropicKey = (_b = values.get('ANTHROPIC_API_KEY')) !== null && _b !== void 0 ? _b : '';
            if (anthropicKey) {
                settings['ai-features.anthropic.AnthropicApiKey'] = anthropicKey;
            }
            else {
                delete settings['ai-features.anthropic.AnthropicApiKey'];
            }
            // Gemini via Theia's NATIVE Google AI provider (uses the Gemini
            // SDK directly, not the OpenAI-compatible endpoint). This avoids the
            // OpenAI `runTools` streaming bug where Gemini omits the tool-call
            // `index` field and tool calling silently breaks.
            const geminiKey = (_c = values.get('GEMINI_API_KEY')) !== null && _c !== void 0 ? _c : '';
            const managedGeminiIds = new Set(['gemini-2.5-flash', 'gemini-2.5-pro']);
            if (geminiKey) {
                settings['ai-features.google.apiKey'] = geminiKey;
                settings['ai-features.google.models'] = ['gemini-2.5-flash', 'gemini-2.5-pro'];
            }
            else {
                delete settings['ai-features.google.apiKey'];
            }
            // Drop any legacy OpenAI-compat Gemini entries we used to manage so
            // the same model id isn't registered twice; preserve user-added ones.
            const existingCustom = (_d = settings['ai-features.openAiCustom.customOpenAiModels']) !== null && _d !== void 0 ? _d : [];
            const userCustom = existingCustom.filter(m => !(managedGeminiIds.has(m['id'])
                && typeof m['url'] === 'string'
                && m['url'].includes('generativelanguage.googleapis.com')));
            if (userCustom.length > 0) {
                settings['ai-features.openAiCustom.customOpenAiModels'] = userCustom;
            }
            else {
                delete settings['ai-features.openAiCustom.customOpenAiModels'];
            }
            // Language model aliases — point default purposes to gemini-2.5-flash when key is set
            if (geminiKey) {
                const currentAliases = (_e = settings['ai-features.languageModelAliases']) !== null && _e !== void 0 ? _e : {};
                const managedAliases = {
                    'default/fast': { selectedModel: 'google/gemini-2.5-flash' },
                    'default/universal': { selectedModel: 'google/gemini-2.5-flash' },
                    'default/code': { selectedModel: 'google/gemini-2.5-flash' },
                    'default/summarize': { selectedModel: 'google/gemini-2.5-flash' },
                    'default/code-completion': { selectedModel: 'google/gemini-2.5-flash' },
                };
                settings['ai-features.languageModelAliases'] = { ...currentAliases, ...managedAliases };
            }
        }
        // 3. Sync enabled MCP servers from integration registry --------------
        const store = this.store();
        const allIntegrations = await store.list();
        const enabledMcp = allIntegrations.filter(r => r.enabled && r.kind === 'mcp');
        const mcpServers = {};
        for (const rec of enabledMcp) {
            const secrets = await store.getDecryptedSecrets(rec.id);
            const transport = (_f = rec.values['transport']) !== null && _f !== void 0 ? _f : 'stdio';
            if (transport === 'http') {
                mcpServers[rec.name] = {
                    serverUrl: (_g = rec.values['url']) !== null && _g !== void 0 ? _g : '',
                    ...(secrets['token'] ? { serverAuthToken: secrets['token'] } : {})
                };
            }
            else {
                // stdio
                const cmd = (_h = rec.values['command']) !== null && _h !== void 0 ? _h : '';
                const argsRaw = ((_j = rec.values['args']) !== null && _j !== void 0 ? _j : '').trim();
                const args = argsRaw ? argsRaw.split(/\s+/) : [];
                const envLines = ((_k = rec.values['env']) !== null && _k !== void 0 ? _k : '').trim();
                const envVars = {};
                if (envLines) {
                    for (const line of envLines.split(/\r?\n/)) {
                        const eq = line.indexOf('=');
                        if (eq > 0) {
                            envVars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
                        }
                    }
                }
                mcpServers[rec.name] = {
                    ...(cmd ? { command: cmd } : {}),
                    ...(args.length ? { args } : {}),
                    ...(Object.keys(envVars).length ? { env: envVars } : {})
                };
            }
        }
        settings['ai-features.mcp.mcpServers'] = mcpServers;
        // 4. AI feature flags (always-on managed keys)
        settings['ai-features.AiEnable.enableAI'] = true;
        // Default chat agent — only write if not already set by the user
        if (!settings['ai-features.chat.defaultChatAgent']) {
            settings['ai-features.chat.defaultChatAgent'] = 'assistant';
        }
        // 5. Write back atomically
        await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
        const tmp = settingsPath + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(settings, undefined, 2), 'utf-8');
        await fs.promises.rename(tmp, settingsPath);
    }
    async executeCommand(command, cwd) {
        const root = this.resolveRootDir();
        // Confine the working directory to the project root subtree.
        const workdir = cwd ? this.safeResolve(cwd) : root;
        return new Promise(resolve => {
            (0, child_process_1.exec)(command, {
                cwd: workdir,
                timeout: ConfigPlaneServiceImpl_1.COMMAND_TIMEOUT_MS,
                maxBuffer: ConfigPlaneServiceImpl_1.MAX_OUTPUT_BYTES,
                windowsHide: true,
                env: process.env
            }, (error, stdout, stderr) => {
                const err = error;
                const timedOut = !!err && (err.killed === true || err.signal === 'SIGTERM');
                const exitCode = err && typeof err.code === 'number' ? err.code : (err ? null : 0);
                resolve({
                    stdout: this.truncate(stdout !== null && stdout !== void 0 ? stdout : '', ConfigPlaneServiceImpl_1.MAX_OUTPUT_BYTES),
                    stderr: this.truncate(stderr !== null && stderr !== void 0 ? stderr : '', ConfigPlaneServiceImpl_1.MAX_OUTPUT_BYTES),
                    exitCode,
                    timedOut
                });
            });
        });
    }
    async fetchUrl(url) {
        var _a;
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            throw new Error(`Invalid URL: ${url}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`Unsupported protocol '${parsed.protocol}'. Only http and https are allowed.`);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(parsed.toString(), {
                redirect: 'follow',
                signal: controller.signal,
                headers: { 'User-Agent': 'Command-Center/1.0' }
            });
            const contentType = (_a = response.headers.get('content-type')) !== null && _a !== void 0 ? _a : '';
            const raw = await response.text();
            const body = this.truncate(raw, ConfigPlaneServiceImpl_1.MAX_FETCH_BYTES);
            return {
                status: response.status,
                contentType,
                body,
                truncated: body.length < raw.length
            };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async readProjectFile(relPath) {
        const abs = this.safeResolve(relPath);
        return fs.promises.readFile(abs, 'utf-8');
    }
    async writeProjectFile(relPath, content) {
        const abs = this.safeResolve(relPath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, content, 'utf-8');
    }
    async listProjectFiles(relDir) {
        const abs = this.safeResolve(relDir !== null && relDir !== void 0 ? relDir : '.');
        const dirents = await fs.promises.readdir(abs, { withFileTypes: true });
        return dirents
            .filter(d => !d.name.startsWith('.git') && d.name !== 'node_modules')
            .map(d => ({ name: d.name, type: d.isDirectory() ? 'directory' : 'file' }))
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    }
    /**
     * Resolve a user-supplied relative path against the project root and ensure
     * the result stays inside that root (prevents `../` path traversal).
     */
    safeResolve(relPath) {
        const root = this.resolveRootDir();
        const abs = path.resolve(root, relPath);
        const rel = path.relative(root, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`Path '${relPath}' escapes the project root and is not allowed.`);
        }
        return abs;
    }
    /**
     * Truncate a string to at most `maxBytes` UTF-8 bytes (approximate, char-based).
     */
    truncate(value, maxBytes) {
        if (value.length <= maxBytes) {
            return value;
        }
        return value.slice(0, maxBytes) + `\n…[truncated, ${value.length - maxBytes} more characters]`;
    }
    // --- Workspace sessions -----------------------------------------------
    /**
     * Create the standard `~/.theia/` user-space directories on startup:
     *   - `~/.theia/sessions/scratch/` — default cwd for agents when no project is open
     *   - `~/.theia/workflows/`       — user-authored workflow definitions
     *
     * Workspaces are opened via the `?folder=<path>` query param from the
     * Workspaces panel, so no `recentworkspace.json` write is needed here.
     */
    async bootstrapDirectories() {
        const scratchDir = path.join(this.sessionsDir, 'scratch');
        await fs.promises.mkdir(scratchDir, { recursive: true });
        await fs.promises.mkdir(this.workflowsDir, { recursive: true });
        // Create session metadata for scratch if missing.
        const scratchMeta = path.join(scratchDir, 'session.json');
        if (!fs.existsSync(scratchMeta)) {
            const session = {
                id: 'scratch',
                name: 'Scratch',
                mode: 'scratch',
                path: scratchDir,
                createdAt: new Date().toISOString(),
                ephemeral: false,
            };
            await fs.promises.writeFile(scratchMeta, JSON.stringify(session, undefined, 2), 'utf-8');
        }
    }
    async listSessions() {
        await fs.promises.mkdir(this.sessionsDir, { recursive: true });
        let entries;
        try {
            entries = await fs.promises.readdir(this.sessionsDir, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const sessions = [];
        for (const entry of entries.filter(e => e.isDirectory())) {
            const metaPath = path.join(this.sessionsDir, entry.name, 'session.json');
            try {
                const raw = await fs.promises.readFile(metaPath, 'utf-8');
                sessions.push(JSON.parse(raw));
            }
            catch {
                // Synthesise metadata for dirs without a session.json.
                sessions.push({
                    id: entry.name,
                    name: entry.name,
                    mode: 'named',
                    path: path.join(this.sessionsDir, entry.name),
                    createdAt: new Date().toISOString(),
                    ephemeral: false,
                });
            }
        }
        // scratch always first, then alphabetical.
        return sessions.sort((a, b) => a.mode === 'scratch' ? -1 : b.mode === 'scratch' ? 1 : a.name.localeCompare(b.name));
    }
    async createSession(name, ephemeral) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/, '');
        const id = `${slug}-${Date.now()}`;
        const sessionDir = path.join(this.sessionsDir, id);
        await fs.promises.mkdir(sessionDir, { recursive: true });
        const session = {
            id,
            name,
            mode: ephemeral ? 'ephemeral' : 'named',
            path: sessionDir,
            createdAt: new Date().toISOString(),
            ephemeral,
        };
        await fs.promises.writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(session, undefined, 2), 'utf-8');
        return session;
    }
    // TBD: auto-sweep ephemeral sessions older than N hours on startup.
    async deleteSession(id) {
        if (id === 'scratch') {
            throw new Error('The scratch workspace cannot be deleted.');
        }
        const sessionDir = path.join(this.sessionsDir, id);
        // Resolve and check the path stays inside sessionsDir to prevent traversal.
        const resolved = path.resolve(sessionDir);
        const sessionsResolved = path.resolve(this.sessionsDir);
        if (!resolved.startsWith(sessionsResolved + path.sep)) {
            throw new Error(`Invalid session id '${id}'.`);
        }
        await fs.promises.rm(resolved, { recursive: true, force: true });
    }
    /**
     * Return the absolute path to the scratch (default) workspace, creating
     * it eagerly if it does not exist.  This resolves quickly and is safe to
     * call before `bootstrapDirectories()` finishes.
     */
    async getDefaultWorkspacePath() {
        const scratchDir = path.join(this.sessionsDir, 'scratch');
        await fs.promises.mkdir(scratchDir, { recursive: true });
        return scratchDir;
    }
    // --- User-defined Tools (CRUD + execute) ----------------------------
    async listTools() {
        return this.toolStore().list();
    }
    async createTool(draft) {
        const tool = await this.toolStore().create(draft);
        // Regenerate agent YAML so any agent that already lists this tool in its
        // `tools` array gets the updated "Your Tools" section immediately.
        this.regenerateCustomAgentsYaml().catch(() => { });
        return tool;
    }
    async updateTool(id, patch) {
        const tool = await this.toolStore().update(id, patch);
        this.regenerateCustomAgentsYaml().catch(() => { });
        return tool;
    }
    async deleteTool(id) {
        await this.toolStore().delete(id);
        this.regenerateCustomAgentsYaml().catch(() => { });
    }
    /**
     * Execute a user-defined tool by id.  The runtime:
     * 1. Loads the ToolDefinition from the tool store.
     * 2. Resolves the backing IntegrationRecord (must be an 'api' kind).
     * 3. Builds the URL path (substitutes {key} path parameters).
     * 4. Merges static + dynamic query params and body fields.
     * 5. Delegates to `callIntegration` which handles all auth resolution.
     */
    async executeTool(id, args) {
        var _a, _b, _c, _d, _e;
        const tools = await this.toolStore().list();
        // Accept either the UUID id or the human-readable name — agents know tools
        // by name (from the "Your Tools" prompt section) so both must resolve.
        const tool = tools.find(t => t.id === id || t.name === id);
        if (!tool) {
            const names = tools.map(t => `"${t.name}"`).join(', ') || '(none)';
            return { ok: false, status: 0, body: '', error: `Tool not found: "${id}". Available tools: ${names}` };
        }
        if (!tool.enabled) {
            return { ok: false, status: 0, body: '', error: `Tool "${tool.name}" is disabled.` };
        }
        // Script tools run arbitrary code; HTTP tools build a single request.
        if (((_a = tool.kind) !== null && _a !== void 0 ? _a : 'http') === 'script') {
            return this.executeScriptTool(tool, args);
        }
        if (!tool.integrationId || !tool.path) {
            return { ok: false, status: 0, body: '', error: `Tool "${tool.name}" is missing its integration or path.` };
        }
        // Substitute {key} path segments.
        let resolvedPath = tool.path;
        for (const param of tool.params) {
            if (param.location === 'path') {
                const value = args[param.key];
                if (value !== undefined && value !== null) {
                    resolvedPath = resolvedPath.replace(`{${param.key}}`, String(value));
                }
                else if (param.required) {
                    return { ok: false, status: 0, body: '', error: `Required path parameter "${param.key}" not provided.` };
                }
            }
        }
        // Build query params: static first, then agent-supplied.
        const queryParams = { ...((_b = tool.staticQueryParams) !== null && _b !== void 0 ? _b : {}) };
        for (const param of tool.params) {
            if (param.location === 'query') {
                const value = args[param.key];
                if (value !== undefined && value !== null) {
                    queryParams[param.key] = String(value);
                }
                else if (param.default !== undefined) {
                    queryParams[param.key] = param.default;
                }
                else if (param.required) {
                    return { ok: false, status: 0, body: '', error: `Required query parameter "${param.key}" not provided.` };
                }
            }
        }
        // Build request body: static first, then agent-supplied.
        const bodyFields = { ...((_c = tool.staticBody) !== null && _c !== void 0 ? _c : {}) };
        let hasBodyParam = false;
        for (const param of tool.params) {
            if (param.location === 'body') {
                const value = args[param.key];
                if (value !== undefined && value !== null) {
                    bodyFields[param.key] = value;
                    hasBodyParam = true;
                }
                else if (param.default !== undefined) {
                    bodyFields[param.key] = param.default;
                    hasBodyParam = true;
                }
                else if (param.required) {
                    return { ok: false, status: 0, body: '', error: `Required body parameter "${param.key}" not provided.` };
                }
            }
        }
        const body = (hasBodyParam || Object.keys((_d = tool.staticBody) !== null && _d !== void 0 ? _d : {}).length > 0)
            ? bodyFields : undefined;
        return this.callIntegration(tool.integrationId, (_e = tool.method) !== null && _e !== void 0 ? _e : 'GET', resolvedPath, Object.keys(queryParams).length > 0 ? queryParams : undefined, body);
    }
    /**
     * Execute a `script` tool: run arbitrary Python / Node / Bash code that can
     * install packages, call multiple APIs and process files. The program runs
     * in an isolated working directory under `.command-center/tool-scripts/<id>/`
     * and receives:
     *   - `CC_TOOL_ARGS`     env var + `args.json` file — the agent-supplied args.
     *   - `CC_INTEGRATIONS`  env var — resolved credentials for referenced
     *                        integrations (base URL + bearer/api-key/basic).
     * Whatever the program writes to stdout becomes the tool result.
     */
    async executeScriptTool(tool, args) {
        var _a, _b, _c, _d;
        const runtime = (_a = tool.runtime) !== null && _a !== void 0 ? _a : 'python';
        const code = (_b = tool.code) !== null && _b !== void 0 ? _b : '';
        if (!code.trim()) {
            return { ok: false, status: 0, body: '', error: `Script tool "${tool.name}" has no code.` };
        }
        // Resolve declared params (apply defaults / enforce required), then
        // pass through any extra args the agent supplied.
        const resolved = {};
        for (const p of tool.params) {
            const v = args[p.key];
            if (v !== undefined && v !== null) {
                resolved[p.key] = v;
            }
            else if (p.default !== undefined) {
                resolved[p.key] = p.default;
            }
            else if (p.required) {
                return { ok: false, status: 0, body: '', error: `Required parameter "${p.key}" not provided.` };
            }
        }
        for (const [k, v] of Object.entries(args)) {
            if (!(k in resolved)) {
                resolved[k] = v;
            }
        }
        const integrations = await this.resolveIntegrationsForScript((_c = tool.integrationRefs) !== null && _c !== void 0 ? _c : []);
        // Isolated working directory for this tool.
        const root = this.resolveRootDir();
        const scriptDir = path.join(root, '.command-center', 'tool-scripts', tool.id);
        await fs.promises.mkdir(scriptDir, { recursive: true });
        const ext = runtime === 'python' ? 'py' : runtime === 'node' ? 'js' : 'sh';
        const scriptFile = path.join(scriptDir, `main.${ext}`);
        await fs.promises.writeFile(scriptFile, code, 'utf-8');
        await fs.promises.writeFile(path.join(scriptDir, 'args.json'), JSON.stringify(resolved, undefined, 2), 'utf-8');
        // Write any additional files for multi-file tools, pruning stale ones
        // left over from a previous version of the tool.
        await this.writeToolFiles(tool, scriptDir);
        // Install packages (best-effort, cached by content hash).
        const reqError = await this.ensureToolRequirements(tool, scriptDir).catch(e => String(e));
        if (reqError) {
            return { ok: false, status: 0, body: '', error: `Failed to install requirements: ${reqError}` };
        }
        const env = {
            ...process.env,
            CC_TOOL_ARGS: JSON.stringify(resolved),
            CC_TOOL_NAME: tool.name,
            CC_INTEGRATIONS: JSON.stringify(integrations),
        };
        const command = runtime === 'python' ? `python "${scriptFile}"`
            : runtime === 'node' ? `node "${scriptFile}"`
                : `bash "${scriptFile}"`;
        const timeoutMs = Math.min(Math.max((_d = tool.timeoutMs) !== null && _d !== void 0 ? _d : 120000, 1000), 600000);
        const MAX = ConfigPlaneServiceImpl_1.MAX_OUTPUT_BYTES;
        return new Promise(resolve => {
            (0, child_process_1.exec)(command, { cwd: scriptDir, timeout: timeoutMs, maxBuffer: MAX, windowsHide: true, env }, (error, stdout, stderr) => {
                const err = error;
                const timedOut = !!err && (err.killed === true || err.signal === 'SIGTERM');
                const exitCode = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
                const out = this.truncate(stdout !== null && stdout !== void 0 ? stdout : '', MAX);
                const errOut = this.truncate(stderr !== null && stderr !== void 0 ? stderr : '', MAX);
                if (timedOut) {
                    resolve({ ok: false, status: 124, body: out, error: `Script timed out after ${timeoutMs}ms.${errOut ? ' stderr: ' + errOut : ''}` });
                    return;
                }
                const ok = exitCode === 0;
                resolve({
                    ok,
                    status: exitCode !== null && exitCode !== void 0 ? exitCode : 0,
                    body: out || (ok ? '(script completed with no stdout output)' : ''),
                    truncated: (stdout !== null && stdout !== void 0 ? stdout : '').length > MAX,
                    ...(ok ? {} : { error: errOut || `Script exited with code ${exitCode}.` }),
                });
            });
        });
    }
    /**
     * Write the additional files of a multi-file script tool into its working
     * directory, creating subdirectories as needed. A manifest
     * (`.cc-managed-files.json`) tracks which files this service wrote so that
     * files removed from the tool definition are pruned on the next run. The
     * entry point (`main.*`), `args.json`, installed dependencies
     * (`node_modules`) and requirement markers are never touched.
     */
    async writeToolFiles(tool, scriptDir) {
        var _a;
        const files = (_a = tool.files) !== null && _a !== void 0 ? _a : {};
        const manifestPath = path.join(scriptDir, '.cc-managed-files.json');
        // Prune files we previously wrote that are no longer part of the tool.
        let previous = [];
        try {
            const raw = await fs.promises.readFile(manifestPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed))
                previous = parsed.filter((x) => typeof x === 'string');
        }
        catch { /* no manifest yet */ }
        const current = new Set(Object.keys(files).map(k => k.replace(/\\/g, '/')));
        for (const rel of previous) {
            if (!current.has(rel)) {
                const abs = this.resolveInsideDir(scriptDir, rel);
                if (abs) {
                    await fs.promises.rm(abs, { force: true }).catch(() => undefined);
                }
            }
        }
        // Write the current file set.
        const written = [];
        for (const [rel, content] of Object.entries(files)) {
            const normalized = rel.replace(/\\/g, '/');
            const abs = this.resolveInsideDir(scriptDir, normalized);
            if (!abs) {
                continue; // refuse to escape the working dir
            }
            await fs.promises.mkdir(path.dirname(abs), { recursive: true });
            await fs.promises.writeFile(abs, content !== null && content !== void 0 ? content : '', 'utf-8');
            written.push(normalized);
        }
        await fs.promises.writeFile(manifestPath, JSON.stringify(written), 'utf-8');
    }
    /** Resolve a relative path within `baseDir`, returning undefined if it escapes. */
    resolveInsideDir(baseDir, rel) {
        const abs = path.resolve(baseDir, rel);
        const baseResolved = path.resolve(baseDir);
        if (abs !== baseResolved && !abs.startsWith(baseResolved + path.sep)) {
            return undefined;
        }
        return abs;
    }
    /**
     * Resolve referenced integrations into a JSON-serializable map (keyed by
     * both id and name) of credentials for a script tool to consume.
     */
    async resolveIntegrationsForScript(ids) {
        var _a, _b, _c;
        const result = {};
        if (!ids.length) {
            return result;
        }
        const records = await this.store().list();
        for (const id of ids) {
            const rec = records.find(r => r.id === id || r.name === id);
            if (!rec) {
                continue;
            }
            const entry = {
                id: rec.id,
                name: rec.name,
                kind: rec.kind,
                baseUrl: (_a = rec.values.baseUrl) !== null && _a !== void 0 ? _a : '',
                authType: (_b = rec.values.authType) !== null && _b !== void 0 ? _b : 'none',
            };
            try {
                const secrets = await this.store().getDecryptedSecrets(rec.id);
                const authType = (_c = rec.values.authType) !== null && _c !== void 0 ? _c : 'none';
                if (authType.startsWith('oauth2')) {
                    try {
                        entry.bearerToken = await this.ensureAccessToken(rec.id);
                    }
                    catch { /* token unavailable */ }
                }
                else if (authType === 'bearer' && secrets.apiKey) {
                    entry.bearerToken = secrets.apiKey;
                    entry.apiKey = secrets.apiKey;
                }
                else if (authType === 'api-key-header') {
                    entry.apiKey = secrets.apiKeyHeaderValue;
                    entry.headerName = rec.values.headerName || 'X-API-Key';
                }
                else if (authType === 'basic') {
                    entry.username = rec.values.username;
                    entry.password = secrets.password;
                }
                // Expose every decrypted secret so non-standard auth still works.
                entry.secrets = secrets;
            }
            catch { /* ignore secret resolution errors */ }
            result[rec.id] = entry;
            if (rec.name && rec.name !== rec.id) {
                result[rec.name] = entry;
            }
        }
        return result;
    }
    /**
     * Install a script tool's package requirements once, caching success by a
     * content hash so repeated runs are fast. Bash tools have no package step.
     */
    async ensureToolRequirements(tool, scriptDir) {
        var _a;
        const reqs = (_a = tool.requirements) !== null && _a !== void 0 ? _a : [];
        if (!reqs.length || tool.runtime === 'bash') {
            return '';
        }
        const hash = crypto.createHash('sha1').update(reqs.slice().sort().join('\n')).digest('hex');
        const marker = path.join(scriptDir, `.requirements-${hash}`);
        if (fs.existsSync(marker)) {
            return '';
        }
        const pkgList = reqs.map(r => `"${r}"`).join(' ');
        const cmd = tool.runtime === 'node'
            ? `npm install --prefix "${scriptDir}" ${pkgList}`
            : `python -m pip install --quiet --disable-pip-version-check ${pkgList}`;
        const res = await new Promise(resolve => {
            (0, child_process_1.exec)(cmd, { cwd: scriptDir, timeout: 300000, maxBuffer: ConfigPlaneServiceImpl_1.MAX_OUTPUT_BYTES, windowsHide: true, env: process.env }, (error, stdout, stderr) => {
                const err = error;
                resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout: stdout !== null && stdout !== void 0 ? stdout : '', stderr: stderr !== null && stderr !== void 0 ? stderr : '' });
            });
        });
        if (res.code !== 0) {
            return this.truncate(res.stderr || res.stdout || `install exited ${res.code}`, 4000);
        }
        await fs.promises.writeFile(marker, reqs.join('\n'), 'utf-8');
        return '';
    }
};
exports.ConfigPlaneServiceImpl = ConfigPlaneServiceImpl;
/** Keys whose values are treated as secrets and withheld from the client. */
ConfigPlaneServiceImpl.SECRET_PATTERN = /(SECRET|PASSWORD|TOKEN|API_KEY|MASTER_KEY|ENCRYPTION_KEY|CLIENT_SECRET|GITHUB_PAT|DATABASE_URL|ACCESS_TOKEN|REFRESH_TOKEN|PUBLIC_KEY|PRIVATE_KEY|AUTH_SECRET|AUTH_GOOGLE_ID)/;
/** Ordered section definitions; each key lands in the first that matches. */
ConfigPlaneServiceImpl.SECTIONS = [
    {
        id: 'llm-keys',
        group: 'llms',
        title: 'LLM Provider Keys',
        description: 'Credentials for the model providers. Encrypted at rest.',
        match: k => /^(ANTHROPIC|OPENAI|GEMINI)_API_KEY$/.test(k)
            || k === 'COPILOT_LLM_API_KEY'
    },
    {
        id: 'model-selection',
        group: 'llms',
        title: 'Model Selection & Routing',
        description: 'Default + per-runtime models, routed via acb_llm → LiteLLM.',
        match: k => k.startsWith('LITELLM_')
            || k.startsWith('VLLM_')
            || k === 'OPENHANDS_DEFAULT_MODEL'
            || k === 'COPILOT_MODEL'
            || k === 'COPILOT_LLM_BASE_URL'
    },
    {
        id: 'integrations',
        group: 'apis',
        title: 'Service APIs',
        description: 'Source-of-truth systems and messaging channels agents act on.',
        match: k => k.startsWith('CLICKUP_')
            || k.startsWith('ZOHO_')
            || k.startsWith('OUTLOOK_')
            || k.startsWith('ODOO_')
            || k.startsWith('WHATSAPP_')
            || k === 'GITHUB_PAT'
            || k === 'ALLOWED_EMAIL_DOMAIN'
    },
    {
        id: 'oauth-auth',
        group: 'apis',
        title: 'OAuth & Auth',
        description: 'Per-provider OAuth grants and session/auth secrets.',
        match: k => k.startsWith('GOOGLE_SSO_')
            || k.startsWith('AUTH_')
            || k.startsWith('GATEWAY_')
    },
    {
        id: 'infrastructure',
        group: 'other',
        title: 'Infrastructure',
        description: 'Datastores, observability and workflow services.',
        match: k => k.startsWith('POSTGRES_')
            || k.startsWith('REDIS')
            || k.startsWith('LANGFUSE_')
            || k.startsWith('N8N_')
            || k.startsWith('OPENHANDS_')
            || k.startsWith('NEXT_PUBLIC_')
            || k.startsWith('COPILOTKIT_')
            || k.startsWith('SKILLS_')
    },
    {
        id: 'runtime',
        group: 'other',
        title: 'Runtime',
        description: 'Process-level runtime configuration.',
        match: k => k === 'ACB_ENV' || k === 'LOG_LEVEL'
    }
];
// --- Theia settings sync ---------------------------------------------
/** IDs of built-in agents that cannot be deleted. */
ConfigPlaneServiceImpl.BUILTIN_AGENT_IDS = new Set(['assistant', 'agent-creator', 'reflector']);
// --- Agent tool execution (function calling) -------------------------
/** Maximum bytes captured from a command's combined stdout/stderr. */
ConfigPlaneServiceImpl.MAX_OUTPUT_BYTES = 100000;
/** Maximum bytes returned from a fetched URL body. */
ConfigPlaneServiceImpl.MAX_FETCH_BYTES = 200000;
/** Hard time limit for a single command, in milliseconds. */
ConfigPlaneServiceImpl.COMMAND_TIMEOUT_MS = 120000;
__decorate([
    (0, inversify_1.postConstruct)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], ConfigPlaneServiceImpl.prototype, "init", null);
exports.ConfigPlaneServiceImpl = ConfigPlaneServiceImpl = ConfigPlaneServiceImpl_1 = __decorate([
    (0, inversify_1.injectable)()
], ConfigPlaneServiceImpl);
//# sourceMappingURL=config-plane-service.js.map