import { AgentDefinition, AgentDirective, AgentDraft, AgentFeedback, CommandResult, ConfigEntry, ConfigPlaneSnapshot, ConfigPlaneService, ConfigSection, FetchResult, FileEntry, IntegrationCallResult, IntegrationDraft, IntegrationGroup, IntegrationKindSpec, IntegrationRecord, IntegrationTestResult, OAuthAuthorizationInfo, OAuthTokenResult, SkillDraft, SkillSummary, ToolDefinition, ToolDraft, ToolExecuteResult, WorkspaceSession } from '../common/config-plane-protocol';
import { SkillScanResult, TrustScore } from '../common/agent-intelligence';
import { IntegrationStore } from './integration-store';
import { ToolStore } from './tool-store';
/** A section definition with a predicate that claims matching keys. */
interface SectionDef {
    id: string;
    group: IntegrationGroup;
    title: string;
    description: string;
    match: (key: string) => boolean;
}
/**
 * Reads the Command Center environment configuration from disk and exposes a read-only,
 * secret-masked snapshot. Real secret values never leave the backend.
 */
export declare class ConfigPlaneServiceImpl implements ConfigPlaneService {
    /** Keys whose values are treated as secrets and withheld from the client. */
    protected static readonly SECRET_PATTERN: RegExp;
    /**
     * Bootstrap agents and regenerate customAgents.yml (with tool refs) on
     * every backend startup so agents always have the latest tool access even
     * before the Integrations panel is opened for the first time.
     */
    protected init(): void;
    /** Ordered section definitions; each key lands in the first that matches. */
    protected static readonly SECTIONS: SectionDef[];
    getSnapshot(): Promise<ConfigPlaneSnapshot>;
    /** Walk up from the backend cwd looking for `.env`, then `.env.example`. */
    protected resolveEnvFile(): {
        file: string;
        usingExample: boolean;
    } | undefined;
    /** Minimal dotenv parser: `KEY=VALUE`, ignoring comments and blank lines. */
    protected parseEnv(raw: string): Map<string, string>;
    protected toEntry(key: string, value: string): ConfigEntry;
    protected emptySections(): ConfigSection[];
    protected storeInstance?: IntegrationStore;
    /** Lazily create the registry store rooted at the project directory. */
    protected store(): IntegrationStore;
    protected toolStoreInstance?: ToolStore;
    /** Lazily create the tool store rooted at the project directory. */
    protected toolStore(): ToolStore;
    /** Project root = directory of the resolved `.env`, else the backend cwd. */
    protected resolveRootDir(): string;
    getKindSpecs(): Promise<IntegrationKindSpec[]>;
    listIntegrations(): Promise<IntegrationRecord[]>;
    createIntegration(draft: IntegrationDraft): Promise<IntegrationRecord>;
    updateIntegration(id: string, patch: Partial<IntegrationDraft>): Promise<IntegrationRecord>;
    setIntegrationEnabled(id: string, enabled: boolean): Promise<IntegrationRecord>;
    deleteIntegration(id: string): Promise<void>;
    testIntegration(id: string): Promise<IntegrationTestResult>;
    /** Probe an API integration with an authenticated GET to its base URL. */
    protected testApiIntegration(record: IntegrationRecord, secrets: Record<string, string>): Promise<IntegrationTestResult>;
    /** Probe an HTTP-transport MCP server for reachability. stdio servers can't be probed. */
    protected testMcpIntegration(record: IntegrationRecord, secrets: Record<string, string>): Promise<IntegrationTestResult>;
    protected describeUntestable(record: IntegrationRecord, why: string): IntegrationTestResult;
    /** Transient CSRF state per integration id, set by startOAuth. */
    protected readonly pendingOAuthState: Map<string, string>;
    startOAuth(id: string): Promise<OAuthAuthorizationInfo>;
    completeOAuth(id: string, code: string, state?: string): Promise<OAuthTokenResult>;
    /**
     * Resolve a redirect callback by its CSRF `state`: find the integration that
     * started this OAuth flow and exchange the authorization `code` for tokens.
     * Used by the backend /oauth/callback HTTP route so the browser redirect from
     * the provider completes the flow automatically (no manual code copying).
     */
    completeOAuthByState(code: string, state: string): Promise<{
        result: OAuthTokenResult;
        integrationName?: string;
    }>;
    refreshOAuthToken(id: string): Promise<OAuthTokenResult>;
    /**
     * POST an x-www-form-urlencoded token request to the integration's token URL,
     * persist the returned access/refresh tokens (encrypted) and expiry, and
     * return a structured result. Shared by the exchange and refresh paths.
     */
    protected exchangeToken(record: IntegrationRecord, body: URLSearchParams): Promise<OAuthTokenResult>;
    callIntegration(id: string, method: string, path_: string, params?: Record<string, string>, body?: unknown, extraHeaders?: Record<string, string>): Promise<IntegrationCallResult>;
    /**
     * Return a currently-valid bearer access token for an OAuth API integration,
     * transparently refreshing it when missing or within 60s of expiry. Throws
     * when no token can be obtained (e.g. authorization-code flow not completed).
     */
    protected ensureAccessToken(id: string): Promise<string>;
    /** Directories scanned for SKILL.md files, in priority order. */
    protected skillDirs(): string[];
    listSkills(): Promise<SkillSummary[]>;
    getSkill(name: string): Promise<string>;
    scanSkill(name: string): Promise<SkillScanResult>;
    /** Absolute path to the writable user skills directory (~/.theia/skills). */
    protected get userSkillsDir(): string;
    writeSkill(draft: SkillDraft): Promise<SkillSummary>;
    deleteSkill(name: string): Promise<void>;
    /** Recursively collect SKILL.md paths under a directory (depth-limited). */
    protected findSkillFiles(dir: string, depth?: number): string[];
    /** Parse the YAML frontmatter of a SKILL.md into a {@link SkillSummary}. */
    protected parseSkillSummary(raw: string, source: string): SkillSummary | undefined;
    /** Minimal flat-YAML parser for `key: value` frontmatter lines. */
    protected parseSimpleYaml(block: string): Map<string, string>;
    /** Remove the leading `--- ... ---` frontmatter block from a SKILL.md. */
    protected stripFrontmatter(raw: string): string;
    /** IDs of built-in agents that cannot be deleted. */
    protected static readonly BUILTIN_AGENT_IDS: Set<string>;
    /** Directory where individual agent JSON definitions are stored. */
    protected get agentsDir(): string;
    /** Directory where workspace sessions are stored.
     *  On Windows → ~/Documents/CommandCenter; elsewhere → ~/CommandCenter.
     *  This keeps sessions visible in the user's Documents folder rather
     *  than buried in a hidden app-data directory.
     */
    protected get sessionsDir(): string;
    /** Directory where user-authored workflow YAML/JSON specs are stored. */
    protected get workflowsDir(): string;
    /** Slugify a display name to a valid agent id. */
    protected agentId(name: string): string;
    listAgents(): Promise<AgentDefinition[]>;
    createAgent(draft: AgentDraft): Promise<AgentDefinition>;
    updateAgent(id: string, patch: Partial<AgentDraft>): Promise<AgentDefinition>;
    deleteAgent(id: string): Promise<void>;
    protected loadAgent(agentId: string): Promise<AgentDefinition>;
    protected directiveId(): string;
    addDirective(agentId: string, text: string, source?: 'manual' | 'reflector'): Promise<AgentDirective>;
    updateDirective(agentId: string, directiveId: string, text: string): Promise<AgentDirective>;
    removeDirective(agentId: string, directiveId: string): Promise<void>;
    approveDirective(agentId: string, directiveId: string): Promise<AgentDirective>;
    rejectDirective(agentId: string, directiveId: string): Promise<AgentDirective>;
    recordFeedback(agentId: string, signal: 'positive' | 'negative', note?: string, conversationId?: string): Promise<void>;
    listFeedback(agentId: string): Promise<AgentFeedback[]>;
    getAgentTrust(agentId: string): Promise<TrustScore>;
    /**
     * Ensures ~/.theia/agents/ contains the built-in agent JSON definitions
     * (assistant + agent-creator + reflector).  Missing definitions are created;
     * existing ones have their canonical prompt/description refreshed to the
     * latest shipped version *unless the user has manually edited the prompt*
     * (detected via promptVersion > 1 or a recorded promptHistory), so software
     * upgrades reach built-in agents without clobbering user customisations.
     */
    protected bootstrapAgents(): Promise<void>;
    /**
     * Create a built-in agent if absent, or refresh its shipped prompt and
     * description when the user has not manually edited it. User-owned fields
     * (soul, directives, skills, defaultLLM, showInChat, prompt history) are
     * always preserved.
     */
    protected ensureBuiltinAgent(def: AgentDefinition): Promise<void>;
    /**
     * Serialises one agent definition to a YAML block entry suitable for
     * customAgents.yml.  Strings containing YAML special characters are
     * double-quoted.
     */
    protected agentToYamlBlock(agent: AgentDefinition): string;
    /**
     * Build an Identity/Soul section from the agent's `soul` field, if present.
     * Compiled into the prompt header to ground the LLM's persona.
     */
    protected soulPromptSection(agent: AgentDefinition): string;
    /**
     * Build a "Standing Directives" section from active directives.
     * These are injected between the authored prompt and the skill/tool block
     * so they constrain the LLM's behaviour on every response.
     */
    protected directivesPromptSection(agent: AgentDefinition): string;
    /**
     * Build a "Your Skills" prompt section for an agent that has skills
     * assigned. Lists each skill's name, description and when-to-use guidance,
     * and instructs the agent to load full instructions on demand via the
     * `cc_useSkill` tool. Returns '' when the agent has no assigned skills.
     */
    protected skillsPromptSection(agent: AgentDefinition): string;
    /**
     * Build a "Your Tools" prompt section for an agent that has user-defined
     * tools (integration wrappers) assigned. Lists each tool's name, what it
     * does and the integration it calls, and instructs the agent to invoke it
     * with ~{cc_executeTool}. Returns '' when the agent has no assigned tools.
     */
    protected toolsPromptSection(agent: AgentDefinition): string;
    /**
     * Regenerates ~/.theia/prompt-templates/customAgents.yml from the agent
     * JSON files in ~/.theia/agents/.  Called after every agent mutation and
     * on startup via bootstrapAgents.
     */
    protected regenerateCustomAgentsYaml(): Promise<void>;
    /** Skill summaries cached during YAML regeneration (see above). */
    protected cachedSkills?: SkillSummary[];
    /** Tool definitions cached during YAML regeneration (see above). */
    protected cachedToolDefs?: ToolDefinition[];
    /**
     * Writes LLM provider keys from `.env` and enabled MCP servers from the
     * integration store into `~/.theia/settings.json` so that Theia AI
     * automatically picks them up.  Called on startup and after every CRUD
     * mutation — errors are non-fatal and only logged.
     */
    protected syncTheiaSettings(): void;
    protected doSyncTheiaSettings(): Promise<void>;
    /** Maximum bytes captured from a command's combined stdout/stderr. */
    protected static readonly MAX_OUTPUT_BYTES = 100000;
    /** Maximum bytes returned from a fetched URL body. */
    protected static readonly MAX_FETCH_BYTES = 200000;
    /** Hard time limit for a single command, in milliseconds. */
    protected static readonly COMMAND_TIMEOUT_MS = 120000;
    executeCommand(command: string, cwd?: string): Promise<CommandResult>;
    fetchUrl(url: string): Promise<FetchResult>;
    readProjectFile(relPath: string): Promise<string>;
    writeProjectFile(relPath: string, content: string): Promise<void>;
    listProjectFiles(relDir?: string): Promise<FileEntry[]>;
    /**
     * Resolve a user-supplied relative path against the project root and ensure
     * the result stays inside that root (prevents `../` path traversal).
     */
    protected safeResolve(relPath: string): string;
    /**
     * Truncate a string to at most `maxBytes` UTF-8 bytes (approximate, char-based).
     */
    protected truncate(value: string, maxBytes: number): string;
    /**
     * Create the standard `~/.theia/` user-space directories on startup:
     *   - `~/.theia/sessions/scratch/` — default cwd for agents when no project is open
     *   - `~/.theia/workflows/`       — user-authored workflow definitions
     *
     * Workspaces are opened via the `?folder=<path>` query param from the
     * Workspaces panel, so no `recentworkspace.json` write is needed here.
     */
    protected bootstrapDirectories(): Promise<void>;
    listSessions(): Promise<WorkspaceSession[]>;
    createSession(name: string, ephemeral: boolean): Promise<WorkspaceSession>;
    deleteSession(id: string): Promise<void>;
    /**
     * Return the absolute path to the scratch (default) workspace, creating
     * it eagerly if it does not exist.  This resolves quickly and is safe to
     * call before `bootstrapDirectories()` finishes.
     */
    getDefaultWorkspacePath(): Promise<string>;
    listTools(): Promise<ToolDefinition[]>;
    createTool(draft: ToolDraft): Promise<ToolDefinition>;
    updateTool(id: string, patch: Partial<ToolDraft>): Promise<ToolDefinition>;
    deleteTool(id: string): Promise<void>;
    /**
     * Execute a user-defined tool by id.  The runtime:
     * 1. Loads the ToolDefinition from the tool store.
     * 2. Resolves the backing IntegrationRecord (must be an 'api' kind).
     * 3. Builds the URL path (substitutes {key} path parameters).
     * 4. Merges static + dynamic query params and body fields.
     * 5. Delegates to `callIntegration` which handles all auth resolution.
     */
    executeTool(id: string, args: Record<string, unknown>): Promise<ToolExecuteResult>;
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
    executeScriptTool(tool: ToolDefinition, args: Record<string, unknown>): Promise<ToolExecuteResult>;
    /**
     * Write the additional files of a multi-file script tool into its working
     * directory, creating subdirectories as needed. A manifest
     * (`.cc-managed-files.json`) tracks which files this service wrote so that
     * files removed from the tool definition are pruned on the next run. The
     * entry point (`main.*`), `args.json`, installed dependencies
     * (`node_modules`) and requirement markers are never touched.
     */
    protected writeToolFiles(tool: ToolDefinition, scriptDir: string): Promise<void>;
    /** Resolve a relative path within `baseDir`, returning undefined if it escapes. */
    protected resolveInsideDir(baseDir: string, rel: string): string | undefined;
    /**
     * Resolve referenced integrations into a JSON-serializable map (keyed by
     * both id and name) of credentials for a script tool to consume.
     */
    protected resolveIntegrationsForScript(ids: string[]): Promise<Record<string, unknown>>;
    /**
     * Install a script tool's package requirements once, caching success by a
     * content hash so repeated runs are fast. Bash tools have no package step.
     */
    protected ensureToolRequirements(tool: ToolDefinition, scriptDir: string): Promise<string>;
}
export {};
