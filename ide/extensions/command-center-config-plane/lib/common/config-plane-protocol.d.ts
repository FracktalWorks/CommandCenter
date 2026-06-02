/**
 * Shared protocol for the Config Plane service.
 *
 * The backend (Node) reads the Command Center environment configuration (`.env`, falling
 * back to `.env.example`) and exposes a read-only, secret-masked snapshot to the
 * frontend over JSON-RPC. Secret values are NEVER sent to the browser — only a
 * "set / not set" flag and the byte length.
 */
import { SkillScanResult, TrustScore } from './agent-intelligence';
export declare const CONFIG_PLANE_SERVICE_PATH = "/services/command-center-config-plane";
export declare const ConfigPlaneService: unique symbol;
/**
 * Top-level integration groups. Each maps to one collapsible view in the
 * Integrations side bar.
 */
export type IntegrationGroup = 'llms' | 'mcp' | 'apis' | 'webhooks' | 'other';
/**
 * A registrable integration kind. Unlike {@link IntegrationGroup} (a UI
 * grouping), a kind has a schema and supports full create/update/delete via the
 * registry. `infra` covers datastores and other infrastructure endpoints.
 */
export type IntegrationKind = 'mcp' | 'api' | 'webhook' | 'infra';
/** Input control type for a single integration field. */
export type IntegrationFieldType = 'text' | 'url' | 'multiline' | 'select' | 'secret' | 'boolean' | 'number';
/**
 * Declarative description of one configurable field of an integration kind.
 * The same spec drives the human form UI and tells agents exactly what to
 * supply when creating an integration programmatically.
 */
export interface IntegrationFieldSpec {
    key: string;
    label: string;
    type: IntegrationFieldType;
    required?: boolean;
    placeholder?: string;
    help?: string;
    /** Allowed values for `select` fields. */
    options?: string[];
    /** Default value applied when the field is left empty. */
    default?: string;
    /**
     * Optional visibility predicate expressed as `otherFieldKey=value`. The
     * field is only shown/collected when the referenced field equals the value.
     * Multiple values may be given comma-separated (`key=a,b`) to show the
     * field when the referenced field equals any of them.
     */
    showWhen?: string;
    /**
     * Auto-managed fields are written by the system (e.g. OAuth access tokens
     * and expiry timestamps obtained during a token exchange) rather than by
     * the user. They are persisted but hidden from the human configuration form.
     */
    managed?: boolean;
}
/** Schema for one integration kind: its metadata plus its fields. */
export interface IntegrationKindSpec {
    kind: IntegrationKind;
    /** Side-bar view this kind is managed under. */
    group: IntegrationGroup;
    title: string;
    /** Singular noun used in buttons, e.g. "MCP Server" → "Add MCP Server". */
    noun: string;
    description: string;
    fields: IntegrationFieldSpec[];
}
/**
 * A stored integration. Secret field values are NEVER returned — only the set
 * of secret field keys that currently hold a value (`secretsSet`).
 */
export interface IntegrationRecord {
    id: string;
    kind: IntegrationKind;
    name: string;
    description?: string;
    enabled: boolean;
    /** Non-secret field values, keyed by {@link IntegrationFieldSpec.key}. */
    values: Record<string, string>;
    /** Keys of secret fields that currently have a stored (encrypted) value. */
    secretsSet: string[];
    createdAt: string;
    updatedAt: string;
}
/**
 * Payload to create or update an integration. On write, secret values are
 * provided in plaintext under `secrets`; they are encrypted at rest and never
 * echoed back.
 */
export interface IntegrationDraft {
    kind: IntegrationKind;
    name: string;
    description?: string;
    enabled?: boolean;
    values?: Record<string, string>;
    /** Plaintext secret field values, keyed by field key. */
    secrets?: Record<string, string>;
}
/** Outcome of {@link ConfigPlaneService.testIntegration}. */
export interface IntegrationTestResult {
    /** True when the connectivity check succeeded. */
    ok: boolean;
    /** Human-readable summary of the result (status code, error, or guidance). */
    message: string;
    /** HTTP status code, when the test performed an HTTP request. */
    status?: number;
    /** True when this integration kind cannot be auto-tested (e.g. stdio MCP). */
    unsupported?: boolean;
}
/** Result of an authenticated HTTP call made via {@link ConfigPlaneService.callIntegration}. */
export interface IntegrationCallResult {
    /** True when the HTTP response status was < 400. */
    ok: boolean;
    /** HTTP status code returned by the remote server. */
    status: number;
    /** Response body, truncated to a safe length for the agent context window. */
    body: string;
    /** True when the body was truncated. */
    truncated?: boolean;
    /** Error message when the request could not be made at all (e.g. network error). */
    error?: string;
}
/**
 * Authorization details returned by {@link ConfigPlaneService.startOAuth} for
 * the OAuth 2.0 authorization-code flow. The user opens {@link authorizationUrl}
 * in a browser, approves access, and is redirected to {@link redirectUri} with a
 * `?code=...` query parameter that is fed back via
 * {@link ConfigPlaneService.completeOAuth}.
 */
export interface OAuthAuthorizationInfo {
    /** Fully-built provider authorization URL to open in a browser. */
    authorizationUrl: string;
    /** Opaque CSRF state value; echo it back to completeOAuth. */
    state: string;
    /** Redirect URI registered with the provider; where the code is delivered. */
    redirectUri: string;
    /** Human-readable, step-by-step instructions an agent can relay to the user. */
    instructions: string;
}
/** Outcome of an OAuth token acquisition (exchange or refresh). */
export interface OAuthTokenResult {
    /** True when a valid access token was obtained and stored. */
    ok: boolean;
    /** Human-readable summary (success details or the provider error). */
    message: string;
    /** HTTP status code from the token endpoint, when a request was made. */
    status?: number;
    /** ISO timestamp when the access token expires, when the provider returns one. */
    expiresAt?: string;
    /** Scopes granted by the provider, when returned. */
    scope?: string;
    /** True when a refresh token is now stored (enables silent renewal). */
    hasRefreshToken?: boolean;
}
/** A single configuration variable. */
export interface ConfigEntry {
    /** Environment variable name, e.g. `ANTHROPIC_API_KEY`. */
    key: string;
    /** Whether this entry holds a secret (its value is withheld from the client). */
    secret: boolean;
    /** Whether the variable currently has a non-empty value. */
    set: boolean;
    /** Plain value — populated only for non-secret entries. */
    value?: string;
    /** Length of the value in characters — populated only for secret entries. */
    length?: number;
}
/** A named group of related configuration entries. */
export interface ConfigSection {
    id: string;
    /** Which side-bar view this section belongs to. */
    group: IntegrationGroup;
    title: string;
    description: string;
    entries: ConfigEntry[];
}
/** Full read-only snapshot returned to the frontend. */
export interface ConfigPlaneSnapshot {
    /** Absolute path of the env file that was read, or undefined if none found. */
    sourceFile?: string;
    /** True when no `.env` was found and `.env.example` was used as the source. */
    usingExample: boolean;
    sections: ConfigSection[];
}
export interface ConfigPlaneService {
    /** Read and categorise the current Command Center environment configuration. */
    getSnapshot(): Promise<ConfigPlaneSnapshot>;
    /** Schemas for every registrable integration kind (drives forms + agents). */
    getKindSpecs(): Promise<IntegrationKindSpec[]>;
    /** All registered integrations (secret values withheld). */
    listIntegrations(): Promise<IntegrationRecord[]>;
    /** Create a new integration from a draft; returns the stored record. */
    createIntegration(draft: IntegrationDraft): Promise<IntegrationRecord>;
    /** Patch an existing integration; only provided fields are changed. */
    updateIntegration(id: string, patch: Partial<IntegrationDraft>): Promise<IntegrationRecord>;
    /** Enable or disable an integration without otherwise changing it. */
    setIntegrationEnabled(id: string, enabled: boolean): Promise<IntegrationRecord>;
    /** Permanently remove an integration and its stored secrets. */
    deleteIntegration(id: string): Promise<void>;
    /**
     * Best-effort connectivity test for an integration (e.g. an authenticated
     * request to an API base URL, or a reachability check of an MCP/HTTP
     * endpoint). Used by the `cc_testIntegration` agent tool so agents can
     * verify a connection right after configuring it.
     */
    testIntegration(id: string): Promise<IntegrationTestResult>;
    /**
     * Begin the OAuth 2.0 authorization-code flow for an `api` integration whose
     * `authType` is `oauth2-authorization-code`. Builds the provider consent URL
     * (from the stored authorization URL, client id, scope and redirect URI) and
     * returns it plus a CSRF `state`. The user opens the URL, approves access,
     * and the resulting `?code=...` is passed to {@link completeOAuth}.
     */
    startOAuth(id: string): Promise<OAuthAuthorizationInfo>;
    /**
     * Complete the authorization-code flow by exchanging the `code` the user was
     * redirected with for access and refresh tokens. The tokens are encrypted
     * and stored on the integration; subsequent calls/tests use them directly.
     */
    completeOAuth(id: string, code: string, state?: string): Promise<OAuthTokenResult>;
    /**
     * Obtain or renew an access token for an OAuth integration without user
     * interaction: runs the client-credentials grant for
     * `oauth2-client-credentials`, or uses the stored refresh token for
     * `oauth2-authorization-code`. The fresh token is stored for reuse.
     */
    refreshOAuthToken(id: string): Promise<OAuthTokenResult>;
    /**
     * Make an authenticated HTTP request against a configured `api` integration.
     * Authentication headers (Bearer token, API key, Basic, or OAuth access token
     * via auto-refresh) are applied automatically from the stored credentials.
     * The response body is returned as a string (JSON, text, etc.) truncated to a
     * safe limit for the agent context window. This is the primary way for agents
     * to call external APIs — no manual header-building or credential handling
     * needed.
     *
     * @param id      Integration id.
     * @param method  HTTP method (GET, POST, PUT, PATCH, DELETE, …).
     * @param path    URL path relative to the integration's `baseUrl`, or an
     *                absolute URL that overrides `baseUrl`.
     * @param params  Optional query-string parameters (key → value map).
     * @param body    Optional request body (object → JSON-serialised; string → sent as-is).
     * @param headers Optional extra request headers (merged with auth headers).
     */
    callIntegration(id: string, method: string, path: string, params?: Record<string, string>, body?: unknown, headers?: Record<string, string>): Promise<IntegrationCallResult>;
    /** All agents defined in ~/.theia/agents/. */
    listAgents(): Promise<AgentDefinition[]>;
    /** Create a new agent from a draft; returns the stored definition. */
    createAgent(draft: AgentDraft): Promise<AgentDefinition>;
    /** Patch an existing agent; only provided fields are changed. */
    updateAgent(id: string, patch: Partial<AgentDraft>): Promise<AgentDefinition>;
    /** Permanently remove an agent. Built-in agents cannot be deleted. */
    deleteAgent(id: string): Promise<void>;
    /**
     * Add a directive to an agent. `source` defaults to 'manual'.
     * Manual directives start as 'active'; Reflector-proposed ones start as 'pending'.
     */
    addDirective(agentId: string, text: string, source?: 'manual' | 'reflector'): Promise<AgentDirective>;
    /** Update the text of an existing directive (resets evalScore). */
    updateDirective(agentId: string, directiveId: string, text: string): Promise<AgentDirective>;
    /** Remove a directive entirely from an agent. */
    removeDirective(agentId: string, directiveId: string): Promise<void>;
    /** Promote a pending directive to active (goes live in the next compiled prompt). */
    approveDirective(agentId: string, directiveId: string): Promise<AgentDirective>;
    /** Reject and archive a pending directive (status → 'rejected'). */
    rejectDirective(agentId: string, directiveId: string): Promise<AgentDirective>;
    /**
     * Record a thumbs-up or thumbs-down rating for the active agent/session.
     * Stored as JSONL at ~/.theia/agents/{agentId}.feedback.jsonl.
     * Non-blocking — fire and forget from the UI.
     */
    recordFeedback(agentId: string, signal: 'positive' | 'negative', note?: string, conversationId?: string): Promise<void>;
    /**
     * Load the full feedback log for an agent.  Used by the Reflector agent
     * tool (cc_readFeedback) to analyse patterns and propose directives.
     */
    listFeedback(agentId: string): Promise<AgentFeedback[]>;
    /**
     * Compute a recency-weighted 0-100 trust score for an agent from its
     * feedback log. Surfaced in the Agents panel as a reputation indicator.
     */
    getAgentTrust(agentId: string): Promise<TrustScore>;
    /**
     * All workspace sessions under `~/.theia/sessions/`.
     * The `scratch` session is always included and listed first.
     */
    listSessions(): Promise<WorkspaceSession[]>;
    /**
     * Create a new named (or ephemeral) workspace session directory.
     * Returns the session metadata including the absolute path.
     */
    createSession(name: string, ephemeral: boolean): Promise<WorkspaceSession>;
    /**
     * Delete a workspace session and its entire directory.
     * The built-in `scratch` session cannot be deleted.
     */
    deleteSession(id: string): Promise<void>;
    /**
     * Return the absolute path to the default (scratch) workspace directory,
     * creating it synchronously if it does not yet exist.
     * Guaranteed to resolve even before `bootstrapDirectories()` finishes.
     */
    getDefaultWorkspacePath(): Promise<string>;
    /**
     * Discover all skills available to agents, scanned from the repo skill
     * folders and the user skills directory (`~/.theia/skills`).
     */
    listSkills(): Promise<SkillSummary[]>;
    /**
     * Return the full instruction body (Markdown after the frontmatter) of a
     * single skill by name. Used by the `cc_useSkill` agent tool so an
     * agent can load a skill's full steps on demand.
     */
    getSkill(name: string): Promise<string>;
    /**
     * Statically scan a skill's full body for unsafe content (prompt
     * injection, credential leaks, exfiltration, dangerous shell). Used to
     * warn before an agent is granted a skill.
     */
    scanSkill(name: string): Promise<SkillScanResult>;
    /**
     * Create or overwrite a user skill under `~/.theia/skills/`. A `SKILL.md`
     * is written with YAML frontmatter (name, description, optional when-to-use
     * and allowed tools) followed by the instruction body. Returns the saved
     * summary. Used by the `cc_writeSkill` agent tool so agents can author
     * and refine skills from chat.
     */
    writeSkill(draft: SkillDraft): Promise<SkillSummary>;
    /**
     * Permanently delete a user skill (only skills stored under
     * `~/.theia/skills/` can be removed; repo-bundled skills are read-only).
     */
    deleteSkill(name: string): Promise<void>;
    /**
     * Run a shell command from the project root and capture its output.
     * Used by the `cc_runTerminalCommand` agent tool.
     */
    executeCommand(command: string, cwd?: string): Promise<CommandResult>;
    /**
     * Fetch the content of a URL (GET) and return its body as text.
     * Used by the `cc_fetchWebpage` agent tool.
     */
    fetchUrl(url: string): Promise<FetchResult>;
    /**
     * Read a UTF-8 text file relative to the project root.
     * Used by the `cc_readFile` agent tool.
     */
    readProjectFile(relPath: string): Promise<string>;
    /**
     * Write a UTF-8 text file relative to the project root (creates parent
     * directories as needed). Used by the `cc_writeFile` agent tool.
     */
    writeProjectFile(relPath: string, content: string): Promise<void>;
    /**
     * List file and directory names under a directory relative to the project
     * root. Used by the `cc_listFiles` agent tool.
     */
    listProjectFiles(relDir?: string): Promise<FileEntry[]>;
    /** Return all stored tool definitions. */
    listTools(): Promise<ToolDefinition[]>;
    /** Create a new tool definition. */
    createTool(draft: ToolDraft): Promise<ToolDefinition>;
    /** Update an existing tool. Only the supplied fields are changed. */
    updateTool(id: string, patch: Partial<ToolDraft>): Promise<ToolDefinition>;
    /** Permanently delete a tool definition. */
    deleteTool(id: string): Promise<void>;
    /**
     * Execute a stored tool by id.  `args` is a flat key→value map whose keys
     * match the `ToolParamSpec.key` values declared on the tool.  The runtime
     * resolves the backing integration's credentials, substitutes params into
     * the URL path / query string / body, and returns the HTTP response.
     */
    executeTool(id: string, args: Record<string, unknown>): Promise<ToolExecuteResult>;
}
/** Result of running a shell command via {@link ConfigPlaneService.executeCommand}. */
export interface CommandResult {
    stdout: string;
    stderr: string;
    /** Process exit code, or null if the process was killed/timed out. */
    exitCode: number | null;
    /** True when the command was terminated because it exceeded the time limit. */
    timedOut: boolean;
}
/** Result of fetching a URL via {@link ConfigPlaneService.fetchUrl}. */
export interface FetchResult {
    status: number;
    contentType: string;
    /** Response body as text (truncated for very large responses). */
    body: string;
    /** True when the body was truncated to the maximum size. */
    truncated: boolean;
}
/** One entry returned by {@link ConfigPlaneService.listProjectFiles}. */
export interface FileEntry {
    name: string;
    /** 'file' or 'directory'. */
    type: 'file' | 'directory';
}
/**
 * A single standing directive — an imperative behavioural rule that is
 * compiled into the agent's prompt between the authored prompt and the tool
 * block. Active directives fire on every response. Pending ones wait for a
 * human to approve them before going live.
 */
export interface AgentDirective {
    id: string;
    /** Imperative rule, e.g. "Always verify deal stage in Zoho before quoting." */
    text: string;
    /** 'manual' = typed by the user; 'reflector' = proposed by the Reflector agent. */
    source: 'manual' | 'reflector';
    addedAt: string;
    /** Score from last promptfoo eval run against existing test cases, if available. */
    evalScore?: number;
    status: 'active' | 'pending' | 'rejected';
}
/**
 * The stable identity nucleus of an agent — describes *who* it is rather
 * than *what* it does. Compiled into the top of the prompt as context for
 * the LLM to ground its persona.
 */
export interface AgentSoul {
    /** High-level role title, e.g. "Sales Intelligence Agent". */
    role?: string;
    /** Business domain context, e.g. "B2B SaaS pipeline management". */
    domain?: string;
    /** Tone / personality descriptor, e.g. "concise, data-first, never speculative". */
    persona?: string;
    /** Short value statements, e.g. ["accuracy over speed", "escalate uncertainty"]. */
    coreValues?: string[];
}
/** A single thumbs-up/down rating on an agent response. */
export interface AgentFeedback {
    id: string;
    agentId: string;
    signal: 'positive' | 'negative';
    note?: string;
    /** Session/conversation ID from the Theia chat service, if available. */
    conversationId?: string;
    createdAt: string;
}
/** A stored agent definition sourced from ~/.theia/agents/{id}.json. */
export interface AgentDefinition {
    id: string;
    name: string;
    description: string;
    prompt: string;
    defaultLLM: string;
    showInChat: boolean;
    workspaceBinding?: string;
    skills?: string[];
    /** Names of user-defined tools (integration wrappers) granted to this agent. */
    tools?: string[];
    /** True for built-in agents shipped with the software (cannot be deleted). */
    builtin?: boolean;
    /** Stable identity nucleus compiled into the prompt header. */
    soul?: AgentSoul;
    /** Standing behavioural directives injected between prompt and tool block. */
    directives?: AgentDirective[];
    /** Increments each time the authored prompt text is changed. */
    promptVersion?: number;
    /** Last 10 snapshots of (prompt + directives), newest last. */
    promptHistory?: Array<{
        version: number;
        prompt: string;
        directives: AgentDirective[];
        changedAt: string;
    }>;
}
/** Payload to create or update an agent. */
export interface AgentDraft {
    /** Auto-generated from name if omitted. */
    id?: string;
    name: string;
    description: string;
    prompt: string;
    defaultLLM?: string;
    showInChat?: boolean;
    workspaceBinding?: string;
    skills?: string[];
    /** Names of user-defined tools (integration wrappers) granted to this agent. */
    tools?: string[];
    soul?: AgentSoul;
    directives?: AgentDirective[];
}
/**
 * Where a dynamic tool parameter is injected into the HTTP request built by
 * {@link ConfigPlaneService.executeTool}.
 */
export type ToolParamLocation = 'query' | 'body' | 'path';
/**
 * Discriminates the two kinds of user-defined tool:
 *  - `http`   — a single HTTP request against one API integration (the
 *               original, simplest form).
 *  - `script` — an arbitrary Python / Node / Bash program that can install
 *               packages, call multiple APIs, process files, run AI models,
 *               etc.  This is the flexible, "do anything" tool kind.
 */
export type ToolKind = 'http' | 'script';
/** Interpreter used to run a {@link ToolKind} `script` tool. */
export type ToolRuntime = 'python' | 'node' | 'bash';
/** Schema for one dynamic parameter of a user-defined tool. */
export interface ToolParamSpec {
    /** Identifier used by the agent and substituted into the request. */
    key: string;
    /** Human-readable label shown in the UI. */
    label: string;
    /** Describes the parameter to the agent so it knows what to pass. */
    description: string;
    type: 'string' | 'number' | 'boolean';
    required: boolean;
    /** Where to inject the value: query string, JSON body, or {path} template. */
    location: ToolParamLocation;
    /** Optional default value used when the agent omits an optional param. */
    default?: string;
}
/**
 * A user-defined tool — a named, reusable HTTP action tied to a specific
 * integration.  When the agent calls `cc_executeTool`, the runtime resolves
 * the integration credentials, substitutes path/query/body params, and
 * executes the request, returning the response body.
 */
export interface ToolDefinition {
    id: string;
    /** Short display name, e.g. "List Calendar Events". */
    name: string;
    /** What the tool does — shown to agents so they know when to invoke it. */
    description: string;
    /**
     * The kind of tool. `http` (default for legacy tools) performs a single
     * HTTP request; `script` runs an arbitrary program. When omitted, treat as
     * `http` for backwards compatibility.
     */
    kind: ToolKind;
    /** The `IntegrationRecord.id` this tool calls. Required for `http` tools. */
    integrationId?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /**
     * URL path relative to the integration's `baseUrl` (e.g.
     * `/v3/calendars/{calendarId}/events`). Segments wrapped in `{key}` are
     * substituted from agent-supplied args whose `location` is `"path"`.
     * Required for `http` tools.
     */
    path?: string;
    /** Agent-supplied parameters (path, query, or body). */
    params: ToolParamSpec[];
    /** Query-string key/value pairs always appended to every request. */
    staticQueryParams?: Record<string, string>;
    /** JSON body fields always included in every request. */
    staticBody?: Record<string, string>;
    /** Interpreter for `script` tools. */
    runtime?: ToolRuntime;
    /**
     * Source code executed for `script` tools. The program receives the
     * agent-supplied arguments as JSON in the `CC_TOOL_ARGS` environment
     * variable (and an `args.json` file in its working dir), plus resolved
     * credentials for any referenced integrations in `CC_INTEGRATIONS`. Whatever
     * it writes to stdout becomes the tool result. This is the ENTRY POINT —
     * written to `main.py` / `main.js` / `main.sh` and run directly.
     */
    code?: string;
    /**
     * Additional files for multi-file `script` tools, keyed by path relative to
     * the tool's working directory (e.g. `lib/parse.py`, `config.json`). They are
     * written alongside the entry point before each run so the entry point can
     * import / read them. Paths must stay inside the working directory.
     */
    files?: Record<string, string>;
    /**
     * Packages to install before running (pip names for `python`, npm names for
     * `node`). Installed once and cached by content hash.
     */
    requirements?: string[];
    /**
     * Integration ids whose resolved credentials (base URL, API key / bearer
     * token) are injected into the script via the `CC_INTEGRATIONS` env var so a
     * single tool can combine several APIs.
     */
    integrationRefs?: string[];
    /** Hard time limit for a `script` tool run, in milliseconds (default 120000, max 600000). */
    timeoutMs?: number;
    /**
     * Optional logical grouping the tool belongs to, used to organise tools into
     * subsections in the UI and to help agents discover related tools (e.g.
     * "Google Calendar", "Documents", "Sales"). When omitted the UI falls back to
     * the backing integration name (http) or "Scripts" (script).
     */
    category?: string;
    /** Hint to the agent describing what the response contains. */
    responseDescription?: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}
/** Input for creating or updating a {@link ToolDefinition}. */
export interface ToolDraft {
    name: string;
    description: string;
    kind?: ToolKind;
    integrationId?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path?: string;
    params?: ToolParamSpec[];
    staticQueryParams?: Record<string, string>;
    staticBody?: Record<string, string>;
    runtime?: ToolRuntime;
    code?: string;
    /** Additional files for multi-file script tools, keyed by relative path. */
    files?: Record<string, string>;
    requirements?: string[];
    integrationRefs?: string[];
    timeoutMs?: number;
    category?: string;
    responseDescription?: string;
    enabled?: boolean;
}
/** Result returned by {@link ConfigPlaneService.executeTool}. */
export interface ToolExecuteResult {
    ok: boolean;
    status: number;
    body: string;
    truncated?: boolean;
    error?: string;
}
/** Whether a session was created as scratch, a named project, or ephemeral. */
export type SessionMode = 'scratch' | 'named' | 'ephemeral';
/**
 * A workspace session — a named directory under `~/.theia/sessions/` that
 * Theia can open as its workspace root.  Agents operate inside this directory:
 * `shellExecute` cwd, file tools, etc. all resolve relative to it.
 */
export interface WorkspaceSession {
    id: string;
    name: string;
    mode: SessionMode;
    /** Absolute path to the session workspace directory. */
    path: string;
    createdAt: string;
    /**
     * True for ephemeral sessions that can be cleaned up automatically.
     * The `scratch` session is never ephemeral.
     */
    ephemeral: boolean;
}
/**
 * Summary of a discovered skill (parsed from a `SKILL.md` frontmatter). The
 * full instruction body is fetched separately via
 * {@link ConfigPlaneService.getSkill}.
 */
export interface SkillSummary {
    /** Unique skill id, kebab-case (matches the skill folder name). */
    name: string;
    /** One-line description of what the skill does. */
    description: string;
    /** Guidance on when the skill should be used, if declared. */
    whenToUse?: string;
    /** Domain/category derived from the parent folder (e.g. "sales", "triage"). */
    domain?: string;
    /** Tools the skill is allowed to use, if declared in frontmatter. */
    allowedTools?: string[];
    /** Absolute path to the skill's SKILL.md file. */
    source: string;
    /** Static security scan of the skill body, computed during discovery. */
    safety?: SkillScanResult;
}
/**
 * Payload to create or update a user skill via
 * {@link ConfigPlaneService.writeSkill}. The backend assembles the SKILL.md
 * frontmatter from these fields and appends the instruction body.
 */
export interface SkillDraft {
    /** Unique skill id, kebab-case. Auto-slugified from the name if omitted. */
    name: string;
    /** One-line description of what the skill does. */
    description: string;
    /** The full instruction body (Markdown, without frontmatter). */
    body: string;
    /** Optional guidance on when the skill should be used. */
    whenToUse?: string;
    /** Optional domain/category folder (e.g. "sales", "triage"). */
    domain?: string;
    /** Optional list of tool ids the skill is allowed to use. */
    allowedTools?: string[];
}
