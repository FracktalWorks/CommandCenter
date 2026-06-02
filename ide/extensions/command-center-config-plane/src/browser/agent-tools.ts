/**
 * Agent tools for Command Center.
 *
 * These {@link ToolProvider}s give every chat agent the ability to act like a
 * coding assistant (Copilot / Claude Code style): run terminal commands, fetch
 * and read web pages, open links, and read / write / list project files.
 *
 * Terminal execution, web fetching and file I/O run on the backend via the
 * {@link ConfigPlaneService} RPC proxy (avoids browser CORS / sandbox limits).
 * Opening a link happens in the frontend through the {@link WindowService}.
 *
 * Each tool is registered into the shared `ToolInvocationRegistry`. Agents
 * reference them by id (`~{toolId}`) inside their prompt; the ids below match
 * the references injected by the backend agent generator.
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { AgentDraft, AgentSoul, ConfigPlaneService, IntegrationDraft, SkillDraft, ToolParamSpec } from '../common/config-plane-protocol';

/** Provider name shown in the chat tool-call UI. */
const PROVIDER = 'Command Center';

/** Safely parse a tool's JSON argument string into a record. */
function parseArgs(argString: string): Record<string, unknown> {
    if (!argString || !argString.trim()) {
        return {};
    }
    try {
        const value = JSON.parse(argString);
        return value && typeof value === 'object' ? value as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

/** Coerce a tool argument to a string, or undefined when absent. */
function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** Coerce a tool argument to a string array (accepts a JSON array or CSV string too). */
function asStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        return value.map(v => String(v)).filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
        const trimmed = value.trim();
        if (trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.map(v => String(v)).filter(Boolean);
                }
            } catch { /* fall through to CSV */ }
        }
        return trimmed.split(',').map(s => s.trim()).filter(Boolean);
    }
    return undefined;
}

/** Coerce a tool argument to a plain object, or undefined when absent. */
function asObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

/**
 * Normalise a loosely-typed `params` argument (from a chat tool call) into a
 * well-formed {@link ToolParamSpec}[].  LLMs — Gemini especially — often omit
 * optional fields or send the array as a JSON string, so we accept:
 *   - an array of param objects (any subset of fields; missing ones default)
 *   - a JSON string encoding such an array
 *   - a single param object
 * Each entry only needs a `key`; `location` defaults to 'query', `type` to
 * 'string', `required` to false, and `label` to the key. This keeps the
 * function-call schema simple enough that the model reliably produces it.
 */
function normalizeToolParams(value: unknown): ToolParamSpec[] {
    let raw: unknown = value;
    if (typeof raw === 'string' && raw.trim()) {
        try { raw = JSON.parse(raw); } catch { return []; }
    }
    const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
    const out: ToolParamSpec[] = [];
    for (const item of arr) {
        const o = asObject(item);
        if (!o) { continue; }
        const key = asString(o.key)?.trim();
        if (!key) { continue; }
        const loc = asString(o.location);
        const location: ToolParamSpec['location'] =
            loc === 'body' || loc === 'path' ? loc : 'query';
        const t = asString(o.type);
        const type: ToolParamSpec['type'] =
            t === 'number' || t === 'boolean' ? t : 'string';
        const spec: ToolParamSpec = {
            key,
            label: asString(o.label)?.trim() || key,
            description: asString(o.description)?.trim() || key,
            type,
            required: o.required === true || o.required === 'true',
            location,
        };
        const def = asString(o.default);
        if (def !== undefined) { spec.default = def; }
        out.push(spec);
    }
    return out;
}

/**
 * Normalise a static query/body argument into a flat string→string map.
 * Accepts either an object or a JSON string (LLMs frequently send the latter).
 */
function asStringMap(value: unknown): Record<string, string> | undefined {
    let raw: unknown = value;
    if (typeof raw === 'string' && raw.trim()) {
        try { raw = JSON.parse(raw); } catch { return undefined; }
    }
    const obj = asObject(raw);
    if (!obj) { return undefined; }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined && v !== null) { out[k] = String(v); }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

@injectable()
export class RunTerminalCommandToolProvider implements ToolProvider {

    static ID = 'cc_runTerminalCommand';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: RunTerminalCommandToolProvider.ID,
            name: RunTerminalCommandToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Run a shell command on the host from the project root and return its '
                + 'stdout, stderr and exit code. Use this to inspect the system, run builds, '
                + 'git, tests, package managers, or any CLI tool. Commands time out after 2 minutes.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The full shell command to execute, e.g. "git status" or "ls -la".'
                    },
                    cwd: {
                        type: 'string',
                        description: 'Optional working directory, relative to the project root. Defaults to the project root.'
                    }
                },
                required: ['command']
            },
            getArgumentsShortLabel: args => {
                const command = asString(parseArgs(args).command) ?? '';
                return { label: command.slice(0, 60), hasMore: command.length > 60 };
            },
            handler: async (argString: string) => {
                const args = parseArgs(argString);
                const command = asString(args.command);
                if (!command) {
                    return 'Error: "command" is required.';
                }
                const cwd = asString(args.cwd);
                const result = await this.configPlane.executeCommand(command, cwd);
                const parts: string[] = [];
                parts.push(`Exit code: ${result.exitCode === null ? 'killed' : result.exitCode}`);
                if (result.timedOut) {
                    parts.push('(command timed out after 2 minutes)');
                }
                if (result.stdout) {
                    parts.push(`--- stdout ---\n${result.stdout}`);
                }
                if (result.stderr) {
                    parts.push(`--- stderr ---\n${result.stderr}`);
                }
                if (!result.stdout && !result.stderr) {
                    parts.push('(no output)');
                }
                return parts.join('\n');
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Web fetch
// ---------------------------------------------------------------------------

@injectable()
export class FetchWebpageToolProvider implements ToolProvider {

    static ID = 'cc_fetchWebpage';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: FetchWebpageToolProvider.ID,
            name: FetchWebpageToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Fetch the content of a web page or HTTP(S) URL and return its body as text. '
                + 'Use this to read documentation, articles, APIs or any link the user mentions.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The absolute http:// or https:// URL to fetch.'
                    }
                },
                required: ['url']
            },
            getArgumentsShortLabel: args => {
                const url = asString(parseArgs(args).url) ?? '';
                return { label: url.slice(0, 60), hasMore: url.length > 60 };
            },
            handler: async (argString: string) => {
                const url = asString(parseArgs(argString).url);
                if (!url) {
                    return 'Error: "url" is required.';
                }
                try {
                    const result = await this.configPlane.fetchUrl(url);
                    const header = `HTTP ${result.status} · ${result.contentType || 'unknown content-type'}`
                        + (result.truncated ? ' · (body truncated)' : '');
                    return `${header}\n\n${result.body}`;
                } catch (err) {
                    return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Open link
// ---------------------------------------------------------------------------

@injectable()
export class OpenLinkToolProvider implements ToolProvider {

    static ID = 'cc_openLink';

    @inject(WindowService)
    protected readonly windowService: WindowService;

    getTool(): ToolRequest {
        return {
            id: OpenLinkToolProvider.ID,
            name: OpenLinkToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Open a URL in a new browser tab/window for the user to view. '
                + 'Use this when the user asks to open or visit a link or website.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The absolute http:// or https:// URL to open.'
                    }
                },
                required: ['url']
            },
            getArgumentsShortLabel: args => {
                const url = asString(parseArgs(args).url) ?? '';
                return { label: url.slice(0, 60), hasMore: url.length > 60 };
            },
            handler: async (argString: string) => {
                const url = asString(parseArgs(argString).url);
                if (!url) {
                    return 'Error: "url" is required.';
                }
                this.windowService.openNewWindow(url, { external: true });
                return `Opened ${url} in a new window.`;
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Read file
// ---------------------------------------------------------------------------

@injectable()
export class ReadFileToolProvider implements ToolProvider {

    static ID = 'cc_readFile';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ReadFileToolProvider.ID,
            name: ReadFileToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Read the UTF-8 text content of a file in the project, given a path relative to '
                + 'the project root. Use this to inspect source code or configuration before editing.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path relative to the project root, e.g. "src/index.ts".'
                    }
                },
                required: ['path']
            },
            getArgumentsShortLabel: args => {
                const path = asString(parseArgs(args).path) ?? '';
                return { label: path.slice(0, 60), hasMore: path.length > 60 };
            },
            handler: async (argString: string) => {
                const filePath = asString(parseArgs(argString).path);
                if (!filePath) {
                    return 'Error: "path" is required.';
                }
                try {
                    return await this.configPlane.readProjectFile(filePath);
                } catch (err) {
                    return `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Write file
// ---------------------------------------------------------------------------

@injectable()
export class WriteFileToolProvider implements ToolProvider {

    static ID = 'cc_writeFile';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: WriteFileToolProvider.ID,
            name: WriteFileToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Write (create or overwrite) a UTF-8 text file in the project, given a path '
                + 'relative to the project root. Parent directories are created automatically.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path relative to the project root, e.g. "notes/todo.md".'
                    },
                    content: {
                        type: 'string',
                        description: 'The full new content of the file.'
                    }
                },
                required: ['path', 'content']
            },
            getArgumentsShortLabel: args => {
                const path = asString(parseArgs(args).path) ?? '';
                return { label: path.slice(0, 60), hasMore: path.length > 60 };
            },
            handler: async (argString: string) => {
                const args = parseArgs(argString);
                const filePath = asString(args.path);
                const content = asString(args.content);
                if (!filePath) {
                    return 'Error: "path" is required.';
                }
                if (content === undefined) {
                    return 'Error: "content" is required.';
                }
                try {
                    await this.configPlane.writeProjectFile(filePath, content);
                    return `Wrote ${content.length} characters to ${filePath}.`;
                } catch (err) {
                    return `Error writing ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// List files
// ---------------------------------------------------------------------------

@injectable()
export class ListFilesToolProvider implements ToolProvider {

    static ID = 'cc_listFiles';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ListFilesToolProvider.ID,
            name: ListFilesToolProvider.ID,
            providerName: PROVIDER,
            description:
                'List the files and directories inside a project directory, given a path '
                + 'relative to the project root (defaults to the root). Use this to explore the codebase.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Directory path relative to the project root. Defaults to "." (the root).'
                    }
                },
                required: []
            },
            getArgumentsShortLabel: args => {
                const path = asString(parseArgs(args).path) ?? '.';
                return { label: path.slice(0, 60), hasMore: path.length > 60 };
            },
            handler: async (argString: string) => {
                const dir = asString(parseArgs(argString).path) ?? '.';
                try {
                    const entries = await this.configPlane.listProjectFiles(dir);
                    if (entries.length === 0) {
                        return `(empty) ${dir}`;
                    }
                    return entries
                        .map(e => (e.type === 'directory' ? `${e.name}/` : e.name))
                        .join('\n');
                } catch (err) {
                    return `Error listing ${dir}: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Integrations: list supported kinds + their field schemas
// ---------------------------------------------------------------------------

@injectable()
export class ListIntegrationKindsToolProvider implements ToolProvider {

    static ID = 'cc_listIntegrationKinds';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ListIntegrationKindsToolProvider.ID,
            name: ListIntegrationKindsToolProvider.ID,
            providerName: PROVIDER,
            description:
                'List the kinds of integrations that can be configured (MCP servers, APIs, webhooks, '
                + 'infrastructure) together with the exact fields each one needs. Call this FIRST when '
                + 'helping a user set up an integration, so you know which values and secrets to collect.',
            parameters: { type: 'object', properties: {}, required: [] },
            handler: async () => {
                const specs = await this.configPlane.getKindSpecs();
                return JSON.stringify(specs, undefined, 2);
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Integrations: list existing records
// ---------------------------------------------------------------------------

@injectable()
export class ListIntegrationsToolProvider implements ToolProvider {

    static ID = 'cc_listIntegrations';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ListIntegrationsToolProvider.ID,
            name: ListIntegrationsToolProvider.ID,
            providerName: PROVIDER,
            description:
                'List the integrations currently configured (secret values are never returned, only '
                + 'which secret fields are set). Use this to see what already exists before creating or updating.',
            parameters: { type: 'object', properties: {}, required: [] },
            handler: async () => {
                const records = await this.configPlane.listIntegrations();
                if (records.length === 0) {
                    return 'No integrations are configured yet.';
                }
                return JSON.stringify(records, undefined, 2);
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Integrations: create
// ---------------------------------------------------------------------------

@injectable()
export class CreateIntegrationToolProvider implements ToolProvider {

    static ID = 'cc_createIntegration';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: CreateIntegrationToolProvider.ID,
            name: CreateIntegrationToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Create a new integration once you have collected the required values from the user. '
                + 'Provide "kind" (mcp | api | webhook | infra), a "name", non-secret "values" and any '
                + '"secrets" (API keys, tokens, passwords) as objects keyed by the field keys from '
                + 'cc_listIntegrationKinds. Secrets are encrypted at rest. After creating, call '
                + 'cc_testIntegration to verify the connection.',
            parameters: {
                type: 'object',
                properties: {
                    kind: {
                        type: 'string',
                        description: 'Integration kind: "mcp", "api", "webhook" or "infra".'
                    },
                    name: {
                        type: 'string',
                        description: 'A short display name for the integration.'
                    },
                    description: {
                        type: 'string',
                        description: 'Optional description of what the integration is for.'
                    },
                    values: {
                        type: 'object',
                        description: 'Non-secret field values keyed by field key (e.g. {"baseUrl": "https://api.example.com"}).'
                    },
                    secrets: {
                        type: 'object',
                        description: 'Secret field values keyed by field key (e.g. {"apiKey": "sk-..."}). Encrypted at rest.'
                    },
                    enabled: {
                        type: 'boolean',
                        description: 'Whether the integration is enabled. Defaults to true.'
                    }
                },
                required: ['kind', 'name']
            },
            getArgumentsShortLabel: args => {
                const a = parseArgs(args);
                const label = `${asString(a.kind) ?? ''}: ${asString(a.name) ?? ''}`.trim();
                return { label: label.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const a = parseArgs(argString);
                const kind = asString(a.kind);
                const name = asString(a.name);
                if (!kind || !name) {
                    return 'Error: "kind" and "name" are required.';
                }
                const draft: IntegrationDraft = {
                    kind: kind as IntegrationDraft['kind'],
                    name,
                    description: asString(a.description),
                    values: (a.values && typeof a.values === 'object') ? a.values as Record<string, string> : undefined,
                    secrets: (a.secrets && typeof a.secrets === 'object') ? a.secrets as Record<string, string> : undefined,
                    enabled: typeof a.enabled === 'boolean' ? a.enabled : undefined
                };
                try {
                    const record = await this.configPlane.createIntegration(draft);
                    return `Created integration '${record.name}' (id: ${record.id}, kind: ${record.kind}). `
                        + `Secrets set: ${record.secretsSet.length ? record.secretsSet.join(', ') : 'none'}. `
                        + `Run cc_testIntegration with id "${record.id}" to verify the connection.`;
                } catch (err) {
                    return `Error creating integration: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Integrations: update
// ---------------------------------------------------------------------------

@injectable()
export class UpdateIntegrationToolProvider implements ToolProvider {

    static ID = 'cc_updateIntegration';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: UpdateIntegrationToolProvider.ID,
            name: UpdateIntegrationToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Update an existing integration by id. Only the fields you provide are changed. Use this '
                + 'to fix a value, rotate a secret, or rename. Get the id from cc_listIntegrations.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The id of the integration to update.' },
                    name: { type: 'string', description: 'New display name (optional).' },
                    description: { type: 'string', description: 'New description (optional).' },
                    values: { type: 'object', description: 'Non-secret field values to change, keyed by field key.' },
                    secrets: { type: 'object', description: 'Secret field values to set/rotate, keyed by field key.' },
                    enabled: { type: 'boolean', description: 'Enable or disable the integration.' }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                const id = asString(parseArgs(args).id) ?? '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const a = parseArgs(argString);
                const id = asString(a.id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                const patch: Partial<IntegrationDraft> = {
                    name: asString(a.name),
                    description: asString(a.description),
                    values: (a.values && typeof a.values === 'object') ? a.values as Record<string, string> : undefined,
                    secrets: (a.secrets && typeof a.secrets === 'object') ? a.secrets as Record<string, string> : undefined,
                    enabled: typeof a.enabled === 'boolean' ? a.enabled : undefined
                };
                try {
                    const record = await this.configPlane.updateIntegration(id, patch);
                    return `Updated integration '${record.name}' (id: ${record.id}).`;
                } catch (err) {
                    return `Error updating integration: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Integrations: test connection
// ---------------------------------------------------------------------------

@injectable()
export class TestIntegrationToolProvider implements ToolProvider {

    static ID = 'cc_testIntegration';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: TestIntegrationToolProvider.ID,
            name: TestIntegrationToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Test the connectivity of a configured integration by id (an authenticated request to an '
                + 'API base URL, or a reachability check of an HTTP MCP endpoint). Use this right after '
                + 'creating or updating an integration to confirm the credentials work.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The id of the integration to test.' }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                const id = asString(parseArgs(args).id) ?? '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const id = asString(parseArgs(argString).id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                try {
                    const result = await this.configPlane.testIntegration(id);
                    const prefix = result.ok ? 'OK' : 'FAILED';
                    const status = result.status !== undefined ? ` (HTTP ${result.status})` : '';
                    return `${prefix}${status}: ${result.message}`;
                } catch (err) {
                    return `Error testing integration: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Integrations: OAuth 2.0 — start authorization-code consent
// ---------------------------------------------------------------------------

@injectable()
export class StartOAuthToolProvider implements ToolProvider {

    static ID = 'cc_startOAuth';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: StartOAuthToolProvider.ID,
            name: StartOAuthToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Begin the OAuth 2.0 authorization-code flow for an API integration whose authType is '
                + '"oauth2-authorization-code". Returns a provider sign-in URL for the user to open. After '
                + 'they approve and are redirected, they copy the "code" query parameter back to you and you '
                + 'call cc_completeOAuth. Only needed for user-delegated OAuth; client-credentials '
                + 'integrations just use cc_refreshOAuth.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The id of the API integration to authorize.' }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                const id = asString(parseArgs(args).id) ?? '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const id = asString(parseArgs(argString).id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                try {
                    const info = await this.configPlane.startOAuth(id);
                    return `Open this URL to authorize:\n${info.authorizationUrl}\n\n${info.instructions}`;
                } catch (err) {
                    return `Error starting OAuth: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Integrations: OAuth 2.0 — exchange authorization code for tokens
// ---------------------------------------------------------------------------

@injectable()
export class CompleteOAuthToolProvider implements ToolProvider {

    static ID = 'cc_completeOAuth';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: CompleteOAuthToolProvider.ID,
            name: CompleteOAuthToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Finish the OAuth 2.0 authorization-code flow by exchanging the "code" the user copied from '
                + 'their redirect URL for access and refresh tokens. The tokens are encrypted and stored on '
                + 'the integration, so future calls and cc_testIntegration work automatically. Pass the '
                + 'same "state" value returned by cc_startOAuth when you have it.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The id of the API integration being authorized.' },
                    code: { type: 'string', description: 'The authorization code from the redirect URL\'s "code" query parameter.' },
                    state: { type: 'string', description: 'The CSRF state value returned by cc_startOAuth (optional but recommended).' }
                },
                required: ['id', 'code']
            },
            getArgumentsShortLabel: args => {
                const id = asString(parseArgs(args).id) ?? '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const a = parseArgs(argString);
                const id = asString(a.id);
                const code = asString(a.code);
                const state = asString(a.state);
                if (!id || !code) {
                    return 'Error: "id" and "code" are required.';
                }
                try {
                    const result = await this.configPlane.completeOAuth(id, code, state);
                    const prefix = result.ok ? 'OK' : 'FAILED';
                    return `${prefix}: ${result.message}`;
                } catch (err) {
                    return `Error completing OAuth: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Integrations: OAuth 2.0 — obtain / refresh an access token
// ---------------------------------------------------------------------------

@injectable()
export class RefreshOAuthToolProvider implements ToolProvider {

    static ID = 'cc_refreshOAuth';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: RefreshOAuthToolProvider.ID,
            name: RefreshOAuthToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Obtain or renew an OAuth 2.0 access token without user interaction. For '
                + '"oauth2-client-credentials" integrations this runs the client-credentials grant (no '
                + 'browser step needed). For "oauth2-authorization-code" integrations it uses the stored '
                + 'refresh token. Use this to mint the first token for a client-credentials API, or to force '
                + 'a refresh. Tokens are refreshed automatically during cc_testIntegration too.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The id of the OAuth API integration.' }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                const id = asString(parseArgs(args).id) ?? '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const id = asString(parseArgs(argString).id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                try {
                    const result = await this.configPlane.refreshOAuthToken(id);
                    const prefix = result.ok ? 'OK' : 'FAILED';
                    return `${prefix}: ${result.message}`;
                } catch (err) {
                    return `Error refreshing OAuth token: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

/**
 * Lists every skill available to agents (name, domain, description and
 * when-to-use), scanned from the repo skill folders and `~/.theia/skills`.
 */
@injectable()
export class ListSkillsToolProvider implements ToolProvider {

    static ID = 'cc_listSkills';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ListSkillsToolProvider.ID,
            name: ListSkillsToolProvider.ID,
            providerName: PROVIDER,
            description:
                'List the skills (reusable, step-by-step procedures) available to you. Returns each '
                + 'skill\'s name, domain, description and when-to-use guidance. Call cc_useSkill with a '
                + 'skill name to load its full instructions before performing the task.',
            parameters: { type: 'object', properties: {} },
            handler: async () => {
                try {
                    const skills = await this.configPlane.listSkills();
                    if (skills.length === 0) {
                        return 'No skills are currently available.';
                    }
                    return skills
                        .map(s => {
                            const domain = s.domain ? `[${s.domain}] ` : '';
                            const when = s.whenToUse ? `\n    When to use: ${s.whenToUse}` : '';
                            return `- ${domain}${s.name}: ${s.description}${when}`;
                        })
                        .join('\n');
                } catch (err) {
                    return `Error listing skills: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

/**
 * Loads the full instruction body of a single skill by name, so the agent can
 * follow its detailed steps (progressive disclosure).
 */
@injectable()
export class UseSkillToolProvider implements ToolProvider {

    static ID = 'cc_useSkill';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: UseSkillToolProvider.ID,
            name: UseSkillToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Load the full instructions for a skill by name (as listed by cc_listSkills). '
                + 'Returns the skill\'s complete step-by-step procedure, which you should then follow precisely.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The skill name to load (e.g. "deal_followup_draft").' }
                },
                required: ['name']
            },
            getArgumentsShortLabel: args => {
                const name = asString(parseArgs(args).name) ?? '';
                return { label: name.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const name = asString(parseArgs(argString).name);
                if (!name) {
                    return 'Error: "name" is required.';
                }
                try {
                    const body = await this.configPlane.getSkill(name);
                    return `# Skill: ${name}\n\n${body}`;
                } catch (err) {
                    return `Error loading skill: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Agent feedback: read
// ---------------------------------------------------------------------------

/**
 * Loads the recent feedback log for an agent.
 * Used by the Reflector agent to analyse patterns and propose directives.
 */
@injectable()
export class ReadAgentFeedbackToolProvider implements ToolProvider {

    static ID = 'cc_readFeedback';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ReadAgentFeedbackToolProvider.ID,
            name: ReadAgentFeedbackToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Load the recent thumbs-up/thumbs-down feedback for a specific agent. '
                + 'Returns the last 50 entries with timestamps and optional user notes. '
                + 'Use this before proposing directive improvements via cc_proposeDirective.',
            parameters: {
                type: 'object',
                properties: {
                    agentId: { type: 'string', description: 'The agent id to read feedback for (e.g. "assistant", "sales-agent").' }
                },
                required: ['agentId']
            },
            getArgumentsShortLabel: args => {
                const id = asString(parseArgs(args).agentId) ?? '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const agentId = asString(parseArgs(argString).agentId);
                if (!agentId) { return 'Error: "agentId" is required.'; }
                try {
                    const feedback = await this.configPlane.listFeedback(agentId);
                    if (feedback.length === 0) {
                        return `No feedback recorded yet for agent '${agentId}'.`;
                    }
                    const recent = feedback.slice(-50);
                    const pos = recent.filter(f => f.signal === 'positive').length;
                    const neg = recent.filter(f => f.signal === 'negative').length;
                    const entries = recent.map(f =>
                        `[${f.createdAt.slice(0, 16)}] ${f.signal === 'positive' ? '+1' : '-1'}${f.note ? ` — "${f.note}"` : ''}`
                    ).join('\n');
                    return `Agent: ${agentId} | Total: ${recent.length} | Positive: ${pos} | Negative: ${neg}\n\n${entries}`;
                } catch (err) {
                    return `Error reading feedback: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Agent directives: propose (used by Reflector)
// ---------------------------------------------------------------------------

/**
 * Proposes a new standing directive for an agent.
 * Creates a 'pending' directive that appears in the Agents panel for review.
 */
@injectable()
export class ProposeDirectiveToolProvider implements ToolProvider {

    static ID = 'cc_proposeDirective';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ProposeDirectiveToolProvider.ID,
            name: ProposeDirectiveToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Propose a new standing directive for an agent based on observed feedback patterns. '
                + 'The directive is submitted as "pending" and shown in the Agents panel for the user to approve or reject. '
                + 'Keep directives short (≤ 20 words), imperative, specific, and evidence-based.',
            parameters: {
                type: 'object',
                properties: {
                    agentId: { type: 'string', description: 'The agent id to propose the directive for.' },
                    text: { type: 'string', description: 'The directive text (imperative, ≤ 20 words). Example: "Always confirm deal stage in Zoho before drafting a quote."' }
                },
                required: ['agentId', 'text']
            },
            getArgumentsShortLabel: args => {
                const a = parseArgs(args);
                const label = `${asString(a.agentId) ?? ''}: ${asString(a.text) ?? ''}`.trim();
                return { label: label.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const a = parseArgs(argString);
                const agentId = asString(a.agentId);
                const text = asString(a.text);
                if (!agentId || !text) { return 'Error: "agentId" and "text" are required.'; }
                try {
                    const directive = await this.configPlane.addDirective(agentId, text, 'reflector');
                    return `Directive proposed (id: ${directive.id}, status: pending): "${directive.text}"\n`
                        + `It will appear in the Agents panel under "${agentId}" for review.`;
                } catch (err) {
                    return `Error proposing directive: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ===========================================================================
// Agent self-configuration — list / inspect / create / update / delete agents
// ===========================================================================
//
// These give every chat agent the ability to *anneal* itself and other agents
// directly from the conversation: read any agent's full definition, create new
// specialised agents, and edit prompts, souls, models, skills and directives.
// The backend persists each agent to ~/.theia/agents/{id}.json and regenerates
// customAgents.yml, so changes take effect on the next message turn.

/** Format an agent definition for display in a tool result. */
function describeAgent(a: {
    id: string; name: string; description: string; defaultLLM: string;
    showInChat: boolean; builtin?: boolean; skills?: string[];
    tools?: string[];
    soul?: { role?: string; domain?: string; persona?: string; coreValues?: string[] };
    directives?: Array<{ id: string; text: string; status: string; source: string }>;
    promptVersion?: number;
}): string {
    const lines: string[] = [];
    lines.push(`### ${a.name} (id: ${a.id})${a.builtin ? ' [built-in]' : ''}`);
    lines.push(`- description: ${a.description}`);
    lines.push(`- model: ${a.defaultLLM}`);
    lines.push(`- showInChat: ${a.showInChat}`);
    if (a.skills?.length) { lines.push(`- skills: ${a.skills.join(', ')}`); }
    if (a.tools?.length) { lines.push(`- tools: ${a.tools.join(', ')}`); }
    if (a.soul) {
        const s = a.soul;
        const parts = [
            s.role ? `role="${s.role}"` : '',
            s.domain ? `domain="${s.domain}"` : '',
            s.persona ? `persona="${s.persona}"` : '',
            s.coreValues?.length ? `values=[${s.coreValues.join('; ')}]` : '',
        ].filter(Boolean);
        if (parts.length) { lines.push(`- soul: ${parts.join(', ')}`); }
    }
    const directives = a.directives ?? [];
    if (directives.length) {
        lines.push(`- directives (${directives.length}):`);
        for (const d of directives) {
            lines.push(`    [${d.status}] (${d.source}, id: ${d.id}) ${d.text}`);
        }
    }
    if (a.promptVersion) { lines.push(`- promptVersion: ${a.promptVersion}`); }
    return lines.join('\n');
}

/** Build an {@link AgentSoul} from loose tool arguments, or undefined. */
function buildSoul(value: unknown): AgentSoul | undefined {
    const obj = asObject(value);
    if (!obj) { return undefined; }
    const soul: AgentSoul = {};
    if (asString(obj.role)) { soul.role = asString(obj.role); }
    if (asString(obj.domain)) { soul.domain = asString(obj.domain); }
    if (asString(obj.persona)) { soul.persona = asString(obj.persona); }
    const values = asStringArray(obj.coreValues);
    if (values) { soul.coreValues = values; }
    return Object.keys(soul).length ? soul : undefined;
}

/**
 * Lists every agent with its core configuration (model, soul, skills,
 * directive summary). The entry point for self-annealing — call this first to
 * discover agent ids before inspecting or editing one.
 */
@injectable()
export class ListAgentsToolProvider implements ToolProvider {

    static ID = 'cc_listAgents';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ListAgentsToolProvider.ID,
            name: ListAgentsToolProvider.ID,
            providerName: PROVIDER,
            description:
                'List all configured agents with their id, name, description, model, soul, assigned '
                + 'skills and directive summary (the full system prompt is omitted — use cc_getAgent '
                + 'for that). Call this first when asked to inspect, edit or improve any agent, including yourself.',
            parameters: { type: 'object', properties: {}, required: [] },
            handler: async () => {
                try {
                    const agents = await this.configPlane.listAgents();
                    if (agents.length === 0) { return 'No agents are configured yet.'; }
                    return agents.map(describeAgent).join('\n\n');
                } catch (err) {
                    return `Error listing agents: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

/** Returns one agent's complete definition, including its full system prompt. */
@injectable()
export class GetAgentToolProvider implements ToolProvider {

    static ID = 'cc_getAgent';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: GetAgentToolProvider.ID,
            name: GetAgentToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Get the complete definition of a single agent by id, INCLUDING its full system prompt, '
                + 'soul, directives and skills. Use this to read an agent before editing it so your changes '
                + 'are surgical and preserve existing behaviour.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The agent id (e.g. "assistant", "agent-creator", or a custom agent id).' }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                const id = asString(parseArgs(args).id) ?? '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const id = asString(parseArgs(argString).id);
                if (!id) { return 'Error: "id" is required.'; }
                try {
                    const agents = await this.configPlane.listAgents();
                    const agent = agents.find(a => a.id === id);
                    if (!agent) {
                        return `Agent '${id}' not found. Known ids: ${agents.map(a => a.id).join(', ') || '(none)'}.`;
                    }
                    return `${describeAgent(agent)}\n\n--- system prompt ---\n${agent.prompt}`;
                } catch (err) {
                    return `Error getting agent: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

/** Creates a new specialised agent from a name, description and system prompt. */
@injectable()
export class CreateAgentToolProvider implements ToolProvider {

    static ID = 'cc_createAgent';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: CreateAgentToolProvider.ID,
            name: CreateAgentToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Create a new specialised agent. Provide a "name", a one-sentence "description" and a '
                + 'full system "prompt". Optionally set the model ("defaultLLM"), whether it appears in the '
                + 'chat picker ("showInChat"), a "soul" (role/domain/persona/coreValues identity object), '
                + 'a list of "skills" by name, and a list of "tools" (integration wrappers, see cc_listTools) the '
                + 'agent can call. The new agent is registered immediately and selectable in chat.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Short display name, e.g. "Invoice Reconciler".' },
                    description: { type: 'string', description: 'One sentence describing the agent\'s job.' },
                    prompt: { type: 'string', description: 'The full system prompt. Include "## Current Context\\n{{contextDetails}}" at the end to receive live context.' },
                    defaultLLM: { type: 'string', description: 'Model id, e.g. "google/gemini-2.5-flash" (default) or "google/gemini-2.5-pro" for complex reasoning.' },
                    showInChat: { type: 'boolean', description: 'Whether the agent appears in the chat agent picker. Defaults to true.' },
                    soul: {
                        type: 'object',
                        description: 'Identity nucleus: { role, domain, persona, coreValues: string[] }.',
                        properties: {
                            role: { type: 'string' },
                            domain: { type: 'string' },
                            persona: { type: 'string' },
                            coreValues: { type: 'array', items: { type: 'string' } }
                        }
                    },
                    skills: { type: 'array', items: { type: 'string' }, description: 'Skill names to grant the agent (see cc_listSkills).' },
                    tools: { type: 'array', items: { type: 'string' }, description: 'User-defined tool names (integration wrappers) to grant the agent (see cc_listTools). Create the tools first with cc_createTool, then grant them here so they appear in the agent\'s tool options.' }
                },
                required: ['name', 'description', 'prompt']
            },
            getArgumentsShortLabel: args => {
                const name = asString(parseArgs(args).name) ?? '';
                return { label: name.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const a = parseArgs(argString);
                const name = asString(a.name);
                const description = asString(a.description);
                const prompt = asString(a.prompt);
                if (!name || !description || !prompt) {
                    return 'Error: "name", "description" and "prompt" are all required.';
                }
                const draft: AgentDraft = {
                    name,
                    description,
                    prompt,
                    defaultLLM: asString(a.defaultLLM),
                    showInChat: typeof a.showInChat === 'boolean' ? a.showInChat : undefined,
                    soul: buildSoul(a.soul),
                    skills: asStringArray(a.skills),
                    tools: asStringArray(a.tools),
                };
                try {
                    const agent = await this.configPlane.createAgent(draft);
                    return `Created agent '${agent.name}' (id: ${agent.id}, model: ${agent.defaultLLM}). `
                        + `It is now registered and selectable in chat${agent.showInChat ? '' : ' (hidden from the picker)'}.`;
                } catch (err) {
                    return `Error creating agent: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

/** Edits an existing agent: prompt, model, soul, skills, visibility, name. */
@injectable()
export class UpdateAgentToolProvider implements ToolProvider {

    static ID = 'cc_updateAgent';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: UpdateAgentToolProvider.ID,
            name: UpdateAgentToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Update an existing agent by id — including yourself. Only the fields you provide change; '
                + 'omit the rest. You can rewrite the system "prompt", change the "defaultLLM", refine the '
                + '"soul", reassign "skills", toggle "showInChat", or rename it. Prompt edits are versioned, so '
                + 'previous prompts are preserved. Read the agent first with cc_getAgent to make precise edits.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The id of the agent to update.' },
                    name: { type: 'string', description: 'New display name (optional).' },
                    description: { type: 'string', description: 'New one-sentence description (optional).' },
                    prompt: { type: 'string', description: 'New full system prompt (optional). Replaces the existing prompt; the old one is kept in history.' },
                    defaultLLM: { type: 'string', description: 'New model id (optional).' },
                    showInChat: { type: 'boolean', description: 'Show or hide the agent in the chat picker (optional).' },
                    soul: {
                        type: 'object',
                        description: 'Replacement identity nucleus: { role, domain, persona, coreValues: string[] }.',
                        properties: {
                            role: { type: 'string' },
                            domain: { type: 'string' },
                            persona: { type: 'string' },
                            coreValues: { type: 'array', items: { type: 'string' } }
                        }
                    },
                    skills: { type: 'array', items: { type: 'string' }, description: 'Replacement list of skill names (optional).' },
                    tools: { type: 'array', items: { type: 'string' }, description: 'Replacement list of user-defined tool names (integration wrappers) for the agent (optional, see cc_listTools).' }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                const id = asString(parseArgs(args).id) ?? '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const a = parseArgs(argString);
                const id = asString(a.id);
                if (!id) { return 'Error: "id" is required.'; }
                const patch: Partial<AgentDraft> = {
                    name: asString(a.name),
                    description: asString(a.description),
                    prompt: asString(a.prompt),
                    defaultLLM: asString(a.defaultLLM),
                    showInChat: typeof a.showInChat === 'boolean' ? a.showInChat : undefined,
                    soul: a.soul !== undefined ? buildSoul(a.soul) : undefined,
                    skills: a.skills !== undefined ? asStringArray(a.skills) : undefined,
                    tools: a.tools !== undefined ? asStringArray(a.tools) : undefined,
                };
                try {
                    const agent = await this.configPlane.updateAgent(id, patch);
                    return `Updated agent '${agent.name}' (id: ${agent.id}). `
                        + `Current model: ${agent.defaultLLM}, promptVersion: ${agent.promptVersion ?? 1}. `
                        + `Changes apply on the next message turn.`;
                } catch (err) {
                    return `Error updating agent: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

/** Permanently deletes a custom (non built-in) agent. */
@injectable()
export class DeleteAgentToolProvider implements ToolProvider {

    static ID = 'cc_deleteAgent';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: DeleteAgentToolProvider.ID,
            name: DeleteAgentToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Permanently delete a custom agent by id. Built-in agents (assistant, agent-creator, reflector) '
                + 'cannot be deleted. This is irreversible — confirm with the user before calling it.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The id of the custom agent to delete.' }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                const id = asString(parseArgs(args).id) ?? '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const id = asString(parseArgs(argString).id);
                if (!id) { return 'Error: "id" is required.'; }
                try {
                    await this.configPlane.deleteAgent(id);
                    return `Deleted agent '${id}'.`;
                } catch (err) {
                    return `Error deleting agent: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

/**
 * Adds a standing directive to an agent. Unlike cc_proposeDirective (which
 * submits a *pending* Reflector proposal), this adds an immediately-active rule.
 */
@injectable()
export class AddDirectiveToolProvider implements ToolProvider {

    static ID = 'cc_addDirective';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: AddDirectiveToolProvider.ID,
            name: AddDirectiveToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Add an immediately-active standing directive to an agent (including yourself). The directive '
                + 'is compiled into the agent\'s prompt on the next turn. Keep it short (≤ 20 words), imperative '
                + 'and specific. Use cc_proposeDirective instead when you want human review before it goes live.',
            parameters: {
                type: 'object',
                properties: {
                    agentId: { type: 'string', description: 'The agent id to add the directive to.' },
                    text: { type: 'string', description: 'The directive text (imperative, ≤ 20 words).' }
                },
                required: ['agentId', 'text']
            },
            getArgumentsShortLabel: args => {
                const a = parseArgs(args);
                return { label: `${asString(a.agentId) ?? ''}: ${asString(a.text) ?? ''}`.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const a = parseArgs(argString);
                const agentId = asString(a.agentId);
                const text = asString(a.text);
                if (!agentId || !text) { return 'Error: "agentId" and "text" are required.'; }
                try {
                    const directive = await this.configPlane.addDirective(agentId, text, 'manual');
                    return `Added active directive (id: ${directive.id}) to '${agentId}': "${directive.text}"`;
                } catch (err) {
                    return `Error adding directive: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

/** Approves, rejects, updates or removes an existing directive on an agent. */
@injectable()
export class ManageDirectiveToolProvider implements ToolProvider {

    static ID = 'cc_manageDirective';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ManageDirectiveToolProvider.ID,
            name: ManageDirectiveToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Manage an existing directive on an agent. "action" is one of: "approve" (promote a pending '
                + 'directive to active), "reject" (archive it), "remove" (delete it entirely), or "update" '
                + '(replace its text — also requires "text"). Get directive ids from cc_listAgents or cc_getAgent.',
            parameters: {
                type: 'object',
                properties: {
                    agentId: { type: 'string', description: 'The agent id the directive belongs to.' },
                    directiveId: { type: 'string', description: 'The directive id to act on.' },
                    action: { type: 'string', description: 'One of: "approve", "reject", "remove", "update".' },
                    text: { type: 'string', description: 'New directive text (required only when action is "update").' }
                },
                required: ['agentId', 'directiveId', 'action']
            },
            getArgumentsShortLabel: args => {
                const a = parseArgs(args);
                return { label: `${asString(a.action) ?? ''} ${asString(a.directiveId) ?? ''}`.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const a = parseArgs(argString);
                const agentId = asString(a.agentId);
                const directiveId = asString(a.directiveId);
                const action = asString(a.action);
                if (!agentId || !directiveId || !action) {
                    return 'Error: "agentId", "directiveId" and "action" are required.';
                }
                try {
                    switch (action) {
                        case 'approve': {
                            const d = await this.configPlane.approveDirective(agentId, directiveId);
                            return `Approved directive ${d.id} on '${agentId}' — now active: "${d.text}"`;
                        }
                        case 'reject': {
                            const d = await this.configPlane.rejectDirective(agentId, directiveId);
                            return `Rejected directive ${d.id} on '${agentId}'.`;
                        }
                        case 'remove': {
                            await this.configPlane.removeDirective(agentId, directiveId);
                            return `Removed directive ${directiveId} from '${agentId}'.`;
                        }
                        case 'update': {
                            const text = asString(a.text);
                            if (!text) { return 'Error: "text" is required when action is "update".'; }
                            const d = await this.configPlane.updateDirective(agentId, directiveId, text);
                            return `Updated directive ${d.id} on '${agentId}': "${d.text}"`;
                        }
                        default:
                            return `Error: unknown action "${action}". Use approve, reject, remove or update.`;
                    }
                } catch (err) {
                    return `Error managing directive: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

/** Creates or overwrites a reusable skill (SKILL.md) authored from chat. */
@injectable()
export class WriteSkillToolProvider implements ToolProvider {

    static ID = 'cc_writeSkill';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: WriteSkillToolProvider.ID,
            name: WriteSkillToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Create or update a reusable skill (a packaged, step-by-step procedure). Provide a "name", a '
                + 'one-line "description", and the full Markdown "body" of instructions. Optionally add '
                + '"whenToUse" guidance, a "domain" category folder (e.g. "sales", "triage"), and "allowedTools". '
                + 'The skill is saved to the user skills directory and becomes loadable via cc_useSkill and '
                + 'assignable to agents. Writing to an existing name overwrites it.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill id / name in kebab-case, e.g. "deal_followup_draft".' },
                    description: { type: 'string', description: 'One-line description of what the skill does.' },
                    body: { type: 'string', description: 'The full Markdown instruction body (the step-by-step procedure).' },
                    whenToUse: { type: 'string', description: 'Optional guidance on when to use the skill.' },
                    domain: { type: 'string', description: 'Optional category folder, e.g. "sales", "delivery", "triage".' },
                    allowedTools: { type: 'array', items: { type: 'string' }, description: 'Optional tool ids the skill may use.' }
                },
                required: ['name', 'description', 'body']
            },
            getArgumentsShortLabel: args => {
                const name = asString(parseArgs(args).name) ?? '';
                return { label: name.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const a = parseArgs(argString);
                const name = asString(a.name);
                const description = asString(a.description);
                const body = asString(a.body);
                if (!name || !description || !body) {
                    return 'Error: "name", "description" and "body" are all required.';
                }
                const draft: SkillDraft = {
                    name,
                    description,
                    body,
                    whenToUse: asString(a.whenToUse),
                    domain: asString(a.domain),
                    allowedTools: asStringArray(a.allowedTools),
                };
                try {
                    const skill = await this.configPlane.writeSkill(draft);
                    const warn = skill.safety && !skill.safety.ok
                        ? ` ⚠ Safety scan flagged this skill (score ${skill.safety.score}/100) — review before use.`
                        : '';
                    return `Saved skill '${skill.name}'${skill.domain ? ` in domain "${skill.domain}"` : ''}. `
                        + `It is now loadable via cc_useSkill and assignable to agents.${warn}`;
                } catch (err) {
                    return `Error writing skill: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

/** Deletes a user-authored skill. */
@injectable()
export class DeleteSkillToolProvider implements ToolProvider {

    static ID = 'cc_deleteSkill';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: DeleteSkillToolProvider.ID,
            name: DeleteSkillToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Permanently delete a user-authored skill by name. Only skills stored in the user skills '
                + 'directory can be removed; repo-bundled skills are read-only. Irreversible — confirm first.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The skill name to delete.' }
                },
                required: ['name']
            },
            getArgumentsShortLabel: args => {
                const name = asString(parseArgs(args).name) ?? '';
                return { label: name.slice(0, 60), hasMore: false };
            },
            handler: async (argString: string) => {
                const name = asString(parseArgs(argString).name);
                if (!name) { return 'Error: "name" is required.'; }
                try {
                    await this.configPlane.deleteSkill(name);
                    return `Deleted skill '${name}'.`;
                } catch (err) {
                    return `Error deleting skill: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Call Integration — authenticated HTTP requests against configured APIs
// ---------------------------------------------------------------------------

/**
 * Makes an authenticated HTTP request to a configured `api` integration.
 * Auth headers (Bearer token, API key, Basic, or OAuth access token with
 * auto-refresh) are applied automatically from the stored credentials.
 * The response body is returned as a string for the agent to parse.
 */
@injectable()
export class CallIntegrationToolProvider implements ToolProvider {

    static ID = 'cc_callIntegration';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: CallIntegrationToolProvider.ID,
            name: CallIntegrationToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Make an authenticated HTTP request to a configured API integration. '
                + 'Auth credentials (Bearer token, API key, Basic auth, or an OAuth access token with '
                + 'auto-refresh) are resolved and applied automatically — you do not need to manage '
                + 'headers or tokens yourself. '
                + 'Use this to call any REST API you have configured, e.g. Google Calendar, Zoho CRM, '
                + 'GitHub, Slack, or any other API integration. '
                + 'The response body (JSON, text, etc.) is returned as a string. '
                + 'For OAuth integrations, the access token is refreshed automatically when it expires. '
                + '"path" can be relative to the integration\'s baseUrl (e.g. "/calendars/primary/events") '
                + 'or an absolute URL. '
                + '"body" is optional and is JSON-serialised when an object is provided.',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'The id of the API integration to call.'
                    },
                    method: {
                        type: 'string',
                        description: 'HTTP method: GET, POST, PUT, PATCH, DELETE, etc.',
                        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
                    },
                    path: {
                        type: 'string',
                        description: 'URL path relative to the integration\'s baseUrl (e.g. "/v3/calendars/primary/events"), '
                            + 'or an absolute URL that overrides baseUrl.'
                    },
                    params: {
                        type: 'object',
                        description: 'Optional query-string parameters as a key → string map.',
                        additionalProperties: { type: 'string' }
                    },
                    body: {
                        description: 'Optional request body. Objects are JSON-serialised; strings are sent as-is.'
                    },
                    headers: {
                        type: 'object',
                        description: 'Optional extra HTTP headers to include (merged with auth headers).',
                        additionalProperties: { type: 'string' }
                    }
                },
                required: ['id', 'method', 'path']
            },
            getArgumentsShortLabel: args => {
                const { method, path } = parseArgs(args);
                const label = `${asString(method) ?? '?'} ${asString(path) ?? ''}`.trim();
                return { label: label.slice(0, 80), hasMore: false };
            },
            handler: async (argString: string) => {
                const args = parseArgs(argString);
                const id = asString(args.id);
                const method = asString(args.method);
                const path = asString(args.path);
                if (!id || !method || !path) {
                    return 'Error: "id", "method", and "path" are all required.';
                }
                const params = asObject(args.params) as Record<string, string> | undefined;
                const headers = asObject(args.headers) as Record<string, string> | undefined;
                const body = args.body;
                try {
                    const result = await this.configPlane.callIntegration(id, method, path, params, body, headers);
                    if (result.error) {
                        return `Error: ${result.error}`;
                    }
                    const truncNote = result.truncated ? '\n[Response truncated to 32 KB]' : '';
                    return `HTTP ${result.status}\n${result.body}${truncNote}`;
                } catch (err) {
                    return `Error calling integration: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

// ---------------------------------------------------------------------------
// User-defined Tool management tool providers
// ---------------------------------------------------------------------------

@injectable()
export class ListToolsToolProvider implements ToolProvider {
    static ID = 'cc_listTools';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ListToolsToolProvider.ID,
            name: ListToolsToolProvider.ID,
            providerName: PROVIDER,
            description:
                'List all user-defined tools. Each tool is a named, reusable HTTP action '
                + 'tied to a specific integration — like "List Calendar Events" or "Create Zoho Task". '
                + 'Returns id, name, description, integrationId, method, path, and parameter schema. '
                + 'Call this before cc_executeTool to find the right tool id, or before cc_createTool '
                + 'to check whether a tool already exists.',
            parameters: { type: 'object', properties: {} },
            handler: async () => {
                try {
                    const tools = await this.configPlane.listTools();
                    if (tools.length === 0) {
                        return 'No tools defined yet. Create one with cc_createTool.';
                    }
                    return tools.map(t => {
                        const kind = t.kind ?? 'http';
                        const backing = kind === 'script'
                            ? [`kind: script (${t.runtime})`, ...(t.files && Object.keys(t.files).length ? [`files: ${Object.keys(t.files).join(', ')}`] : []), ...(t.requirements?.length ? [`requirements: ${t.requirements.join(', ')}`] : []), ...(t.integrationRefs?.length ? [`integrationRefs: ${t.integrationRefs.join(', ')}`] : [])]
                            : [`kind: http`, `integration: ${t.integrationId}`, `method: ${t.method} ${t.path}`];
                        return [
                            `id: ${t.id}`,
                            `name: ${t.name}`,
                            ...(t.category ? [`category: ${t.category}`] : []),
                            ...backing,
                            `params: ${t.params.length > 0 ? t.params.map(p => `${p.key}(${p.location},${p.required ? 'required' : 'optional'})`).join(', ') : 'none'}`,
                            `description: ${t.description}`,
                            `enabled: ${t.enabled}`,
                        ].join('\n');
                    }).join('\n\n---\n\n');
                } catch (err) {
                    return `Error listing tools: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

@injectable()
export class SearchToolsToolProvider implements ToolProvider {
    static ID = 'cc_searchTools';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: SearchToolsToolProvider.ID,
            name: SearchToolsToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Search existing user-defined tools by keyword before doing work. Matches the '
                + 'query against each tool\'s name, description, category, integration, runtime, '
                + 'path and parameter keys, ranked by relevance. ALWAYS call this first when you '
                + 'need to perform an operation: if a suitable tool exists, execute it with '
                + 'cc_executeTool; if none is returned, create one with cc_createTool (an http tool '
                + 'for a single API call, or a script tool for anything programmatic/multi-step).',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Keywords describing the operation you want to perform, e.g. "send calendar invite" or "convert pdf to markdown".' },
                    limit: { type: 'number', description: 'Maximum number of matches to return (default 10).' }
                },
                required: ['query']
            },
            getArgumentsShortLabel: args => {
                const { query } = parseArgs(args);
                return { label: `Search tools: ${asString(query) ?? ''}`, hasMore: false };
            },
            handler: async (argString: string) => {
                const args = parseArgs(argString);
                const query = (asString(args.query) ?? '').trim();
                if (!query) {
                    return 'Error: query is required.';
                }
                const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 10;
                try {
                    const tools = await this.configPlane.listTools();
                    if (tools.length === 0) {
                        return 'No tools defined yet. Create one with cc_createTool.';
                    }
                    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
                    const scored = tools.map(t => {
                        const haystack = [
                            t.name,
                            t.description,
                            t.category,
                            t.kind === 'script' ? `script ${t.runtime} ${(t.requirements ?? []).join(' ')}` : `http ${t.integrationId} ${t.method} ${t.path}`,
                            t.params.map(p => p.key).join(' '),
                        ].filter(Boolean).join(' ').toLowerCase();
                        let score = 0;
                        for (const term of terms) {
                            if (t.name.toLowerCase().includes(term)) score += 3;
                            else if ((t.category ?? '').toLowerCase().includes(term)) score += 2;
                            else if (haystack.includes(term)) score += 1;
                        }
                        return { t, score };
                    }).filter(s => s.score > 0)
                        .sort((a, b) => b.score - a.score)
                        .slice(0, limit);
                    if (scored.length === 0) {
                        return `No tools match "${query}". None exists for this operation yet — create one with cc_createTool (kind="script" for programmatic work).`;
                    }
                    return scored.map(({ t }) => {
                        const backing = (t.kind ?? 'http') === 'script'
                            ? `script (${t.runtime})`
                            : `${t.method} ${t.path} via ${t.integrationId}`;
                        return [
                            `id: ${t.id}`,
                            `name: ${t.name}`,
                            ...(t.category ? [`category: ${t.category}`] : []),
                            `backing: ${backing}`,
                            `params: ${t.params.length > 0 ? t.params.map(p => `${p.key}${p.required ? '*' : ''}`).join(', ') : 'none'}`,
                            `description: ${t.description}`,
                        ].join('\n');
                    }).join('\n\n---\n\n');
                } catch (err) {
                    return `Error searching tools: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

@injectable()
export class CreateToolToolProvider implements ToolProvider {
    static ID = 'cc_createTool';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: CreateToolToolProvider.ID,
            name: CreateToolToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Create a reusable named tool agents invoke via cc_executeTool. Two kinds: '
                + 'kind="http" wraps ONE endpoint of an integration (set integrationId, method, path, params). '
                + 'kind="script" runs a Python/Node/Bash program that can install packages, call multiple '
                + 'APIs, read files and run AI models (set runtime and code). A script reads its args from the '
                + 'CC_TOOL_ARGS env var (JSON) and integration credentials from CC_INTEGRATIONS (JSON), and '
                + 'prints its result to stdout.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Short display name, e.g. "List Calendar Events" or "PDF to Markdown".' },
                    description: { type: 'string', description: 'What this tool does — shown to agents.' },
                    kind: {
                        type: 'string',
                        enum: ['http', 'script'],
                        description: 'Tool kind. "http" = single API request (default). "script" = run code.'
                    },
                    integrationId: { type: 'string', description: '[http] The id of the API integration to call (from cc_listIntegrations).' },
                    method: {
                        type: 'string',
                        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
                        description: '[http] HTTP method.'
                    },
                    path: { type: 'string', description: '[http] URL path relative to the integration\'s baseUrl. Use {key} for path params.' },
                    runtime: {
                        type: 'string',
                        enum: ['python', 'node', 'bash'],
                        description: '[script] Interpreter to run the code with.'
                    },
                    code: {
                        type: 'string',
                        description: '[script] The full entry-point program source. Read inputs from the CC_TOOL_ARGS env var (JSON) and credentials from CC_INTEGRATIONS (JSON); print the result to stdout.'
                    },
                    files: {
                        type: 'string',
                        description: '[script] Optional extra files for multi-file tools, as a JSON object string of relativePath->fileContents (e.g. \'{"lib/parse.py":"..."}\'). Written next to the entry point so code can import/read them. Do not use main.* or args.json.'
                    },
                    requirements: {
                        type: 'string',
                        description: '[script] Optional packages to install first, as a JSON array or comma list (pip for python, npm for node).'
                    },
                    integrationRefs: {
                        type: 'string',
                        description: '[script] Optional integration ids/names whose credentials to inject via CC_INTEGRATIONS, as a JSON array or comma list.'
                    },
                    timeoutMs: {
                        type: 'number',
                        description: '[script] Optional hard time limit in ms (default 120000, max 600000).'
                    },
                    params: {
                        type: 'string',
                        description:
                            'JSON array string of the parameters the agent supplies at call time. Each '
                            + 'element: {"key":...} plus optional "location" (query|body|path, default query), '
                            + '"type" (string|number|boolean), "required", "description". Pass "[]" if none. '
                            + 'Example: \'[{"key":"path","required":true}]\'.'
                    },
                    staticQueryParams: {
                        type: 'string',
                        description: '[http] Optional JSON object string of query-string key/value pairs always appended, e.g. \'{"format":"json"}\'.'
                    },
                    staticBody: {
                        type: 'string',
                        description: '[http] Optional JSON object string of body fields always included, e.g. \'{"source":"command-center"}\'.'
                    },
                    responseDescription: {
                        type: 'string',
                        description: 'Hint to the agent describing what the response contains.'
                    },
                    category: {
                        type: 'string',
                        description: 'Optional logical group this tool belongs to, used to organise tools into subsections (e.g. "Google Calendar", "Documents", "Sales"). Reuse an existing category name from cc_listTools when the tool relates to the same service/area.'
                    }
                },
                required: ['name', 'description']
            },
            getArgumentsShortLabel: args => {
                const { name } = parseArgs(args);
                return { label: `Create tool: ${asString(name) ?? '?'}`, hasMore: false };
            },
            handler: async (argString: string) => {
                const args = parseArgs(argString);
                const name = asString(args.name);
                const description = asString(args.description) ?? '';
                if (!name) {
                    return 'Error: name is required.';
                }
                const kind = asString(args.kind) === 'script' ? 'script' : 'http';
                try {
                    if (kind === 'script') {
                        const runtime = asString(args.runtime) as 'python' | 'node' | 'bash' | undefined;
                        const code = asString(args.code);
                        if (!runtime || !code) {
                            return 'Error: script tools require a runtime (python|node|bash) and code.';
                        }
                        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
                        const tool = await this.configPlane.createTool({
                            name,
                            description,
                            kind: 'script',
                            runtime,
                            code,
                            files: asStringMap(args.files),
                            requirements: asStringArray(args.requirements),
                            integrationRefs: asStringArray(args.integrationRefs),
                            timeoutMs,
                            params: normalizeToolParams(args.params),
                            responseDescription: asString(args.responseDescription),
                            category: asString(args.category),
                        });
                        return `Script tool created.\nid: ${tool.id}\nname: ${tool.name}\nruntime: ${tool.runtime}\nparams: ${tool.params.map(p => p.key).join(', ') || 'none'}`;
                    }
                    const integrationId = asString(args.integrationId);
                    const method = (asString(args.method) ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
                    const path = asString(args.path);
                    if (!integrationId || !path) {
                        return 'Error: http tools require integrationId and path (or set kind="script").';
                    }
                    const tool = await this.configPlane.createTool({
                        name,
                        description,
                        kind: 'http',
                        integrationId,
                        method,
                        path,
                        params: normalizeToolParams(args.params),
                        staticQueryParams: asStringMap(args.staticQueryParams),
                        staticBody: asStringMap(args.staticBody),
                        responseDescription: asString(args.responseDescription),
                        category: asString(args.category),
                    });
                    return `Tool created.\nid: ${tool.id}\nname: ${tool.name}\n${tool.method} ${tool.path}\nparams: ${tool.params.map(p => p.key).join(', ') || 'none'}`;
                } catch (err) {
                    return `Error creating tool: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

@injectable()
export class UpdateToolToolProvider implements ToolProvider {
    static ID = 'cc_updateTool';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: UpdateToolToolProvider.ID,
            name: UpdateToolToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Update an existing user-defined tool. Provide the tool id (from cc_listTools) '
                + 'and any fields to change. Only supplied fields are updated.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The tool id to update.' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    kind: { type: 'string', enum: ['http', 'script'] },
                    integrationId: { type: 'string' },
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                    path: { type: 'string' },
                    runtime: { type: 'string', enum: ['python', 'node', 'bash'], description: '[script] Interpreter.' },
                    code: { type: 'string', description: '[script] Replacement program source.' },
                    files: { type: 'string', description: '[script] Replacement multi-file set as a JSON object string of relativePath->contents. Replaces all extra files; pass "{}" to remove them.' },
                    requirements: { type: 'string', description: '[script] Packages as a JSON array or comma list.' },
                    integrationRefs: { type: 'string', description: '[script] Integration ids/names as a JSON array or comma list.' },
                    timeoutMs: { type: 'number', description: '[script] Time limit in ms.' },
                    params: {
                        type: 'string',
                        description: 'Replacement parameter list as a JSON array string. Each element: {"key":...,"location":"query|body|path","type":...,"required":...,"description":...}. Only "key" is required per element.'
                    },
                    staticQueryParams: { type: 'string', description: 'JSON object string of always-appended query params.' },
                    staticBody: { type: 'string', description: 'JSON object string of always-included body fields.' },
                    responseDescription: { type: 'string' },
                    category: { type: 'string', description: 'Logical group for organising tools into subsections.' },
                    enabled: { type: 'boolean' }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                const { id } = parseArgs(args);
                return { label: `Update tool ${asString(id) ?? '?'}`, hasMore: false };
            },
            handler: async (argString: string) => {
                const args = parseArgs(argString);
                const id = asString(args.id);
                if (!id) return 'Error: id is required.';
                const patch: Record<string, unknown> = {};
                for (const key of ['name', 'description', 'kind', 'integrationId', 'method', 'path', 'runtime', 'code', 'responseDescription', 'category']) {
                    const v = asString((args as Record<string, unknown>)[key]);
                    if (v !== undefined) patch[key] = v;
                }
                if (args.params !== undefined) patch.params = normalizeToolParams(args.params);
                if (args.files !== undefined) patch.files = asStringMap(args.files) ?? {};
                if (args.requirements !== undefined) patch.requirements = asStringArray(args.requirements) ?? [];
                if (args.integrationRefs !== undefined) patch.integrationRefs = asStringArray(args.integrationRefs) ?? [];
                if (typeof args.timeoutMs === 'number') patch.timeoutMs = args.timeoutMs;
                const sq = asStringMap(args.staticQueryParams);
                if (sq) patch.staticQueryParams = sq;
                const sb = asStringMap(args.staticBody);
                if (sb) patch.staticBody = sb;
                if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
                try {
                    const tool = await this.configPlane.updateTool(id, patch as Parameters<ConfigPlaneService['updateTool']>[1]);
                    const where = (tool.kind ?? 'http') === 'script' ? `${tool.runtime} script` : `${tool.method} ${tool.path}`;
                    return `Tool updated.\nid: ${tool.id}\nname: ${tool.name}\n${where}`;
                } catch (err) {
                    return `Error updating tool: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

@injectable()
export class DeleteToolToolProvider implements ToolProvider {
    static ID = 'cc_deleteTool';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: DeleteToolToolProvider.ID,
            name: DeleteToolToolProvider.ID,
            providerName: PROVIDER,
            description: 'Permanently delete a user-defined tool by id. Get the id from cc_listTools.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The tool id to delete.' }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                const { id } = parseArgs(args);
                return { label: `Delete tool ${asString(id) ?? '?'}`, hasMore: false };
            },
            handler: async (argString: string) => {
                const args = parseArgs(argString);
                const id = asString(args.id);
                if (!id) return 'Error: id is required.';
                try {
                    await this.configPlane.deleteTool(id);
                    return `Tool ${id} deleted.`;
                } catch (err) {
                    return `Error deleting tool: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}

@injectable()
export class ExecuteToolToolProvider implements ToolProvider {
    static ID = 'cc_executeTool';

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    getTool(): ToolRequest {
        return {
            id: ExecuteToolToolProvider.ID,
            name: ExecuteToolToolProvider.ID,
            providerName: PROVIDER,
            description:
                'Execute a user-defined tool by name or id. The runtime resolves the backing integration\'s '
                + 'credentials, substitutes params into the URL path / query string / request body, '
                + 'and returns the HTTP response. Use cc_listTools to find available tools and their '
                + 'required params. Prefer this over cc_callIntegration when a tool exists for the action. '
                + 'Both the human-readable tool name (e.g. "List Calendar Events") and the UUID id are accepted.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The tool name (e.g. "List Calendar Events") or UUID id to execute. Both are accepted.' },
                    args: {
                        type: 'object',
                        description: 'Key→value map of parameter values. Keys must match the param keys declared on the tool.',
                        additionalProperties: true
                    }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                const { id } = parseArgs(args);
                return { label: `Execute tool ${asString(id) ?? '?'}`, hasMore: false };
            },
            handler: async (argString: string) => {
                const args = parseArgs(argString);
                const id = asString(args.id);
                if (!id) return 'Error: id is required.';
                let rawArgs: unknown = args.args;
                if (typeof rawArgs === 'string' && rawArgs.trim()) {
                    try { rawArgs = JSON.parse(rawArgs); } catch { /* leave as-is */ }
                }
                const toolArgs = (asObject(rawArgs) ?? {}) as Record<string, unknown>;
                try {
                    const result = await this.configPlane.executeTool(id, toolArgs);
                    if (result.error) {
                        return `Error: ${result.error}`;
                    }
                    const truncNote = result.truncated ? '\n[Response truncated to 32 KB]' : '';
                    return `HTTP ${result.status}\n${result.body}${truncNote}`;
                } catch (err) {
                    return `Error executing tool: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
}