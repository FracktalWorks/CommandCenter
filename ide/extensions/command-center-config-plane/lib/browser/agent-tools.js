"use strict";
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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var RunTerminalCommandToolProvider_1, FetchWebpageToolProvider_1, OpenLinkToolProvider_1, ReadFileToolProvider_1, WriteFileToolProvider_1, ListFilesToolProvider_1, ListIntegrationKindsToolProvider_1, ListIntegrationsToolProvider_1, CreateIntegrationToolProvider_1, UpdateIntegrationToolProvider_1, TestIntegrationToolProvider_1, StartOAuthToolProvider_1, CompleteOAuthToolProvider_1, RefreshOAuthToolProvider_1, ListSkillsToolProvider_1, UseSkillToolProvider_1, ReadAgentFeedbackToolProvider_1, ProposeDirectiveToolProvider_1, ListAgentsToolProvider_1, GetAgentToolProvider_1, CreateAgentToolProvider_1, UpdateAgentToolProvider_1, DeleteAgentToolProvider_1, AddDirectiveToolProvider_1, ManageDirectiveToolProvider_1, WriteSkillToolProvider_1, DeleteSkillToolProvider_1, CallIntegrationToolProvider_1, ListToolsToolProvider_1, SearchToolsToolProvider_1, CreateToolToolProvider_1, UpdateToolToolProvider_1, DeleteToolToolProvider_1, ExecuteToolToolProvider_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecuteToolToolProvider = exports.DeleteToolToolProvider = exports.UpdateToolToolProvider = exports.CreateToolToolProvider = exports.SearchToolsToolProvider = exports.ListToolsToolProvider = exports.CallIntegrationToolProvider = exports.DeleteSkillToolProvider = exports.WriteSkillToolProvider = exports.ManageDirectiveToolProvider = exports.AddDirectiveToolProvider = exports.DeleteAgentToolProvider = exports.UpdateAgentToolProvider = exports.CreateAgentToolProvider = exports.GetAgentToolProvider = exports.ListAgentsToolProvider = exports.ProposeDirectiveToolProvider = exports.ReadAgentFeedbackToolProvider = exports.UseSkillToolProvider = exports.ListSkillsToolProvider = exports.RefreshOAuthToolProvider = exports.CompleteOAuthToolProvider = exports.StartOAuthToolProvider = exports.TestIntegrationToolProvider = exports.UpdateIntegrationToolProvider = exports.CreateIntegrationToolProvider = exports.ListIntegrationsToolProvider = exports.ListIntegrationKindsToolProvider = exports.ListFilesToolProvider = exports.WriteFileToolProvider = exports.ReadFileToolProvider = exports.OpenLinkToolProvider = exports.FetchWebpageToolProvider = exports.RunTerminalCommandToolProvider = void 0;
const inversify_1 = require("@theia/core/shared/inversify");
const window_service_1 = require("@theia/core/lib/browser/window/window-service");
const config_plane_protocol_1 = require("../common/config-plane-protocol");
/** Provider name shown in the chat tool-call UI. */
const PROVIDER = 'Command Center';
/** Safely parse a tool's JSON argument string into a record. */
function parseArgs(argString) {
    if (!argString || !argString.trim()) {
        return {};
    }
    try {
        const value = JSON.parse(argString);
        return value && typeof value === 'object' ? value : {};
    }
    catch {
        return {};
    }
}
/** Coerce a tool argument to a string, or undefined when absent. */
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
/** Coerce a tool argument to a string array (accepts a JSON array or CSV string too). */
function asStringArray(value) {
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
            }
            catch { /* fall through to CSV */ }
        }
        return trimmed.split(',').map(s => s.trim()).filter(Boolean);
    }
    return undefined;
}
/** Coerce a tool argument to a plain object, or undefined when absent. */
function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
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
function normalizeToolParams(value) {
    var _a, _b, _c;
    let raw = value;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            raw = JSON.parse(raw);
        }
        catch {
            return [];
        }
    }
    const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
    const out = [];
    for (const item of arr) {
        const o = asObject(item);
        if (!o) {
            continue;
        }
        const key = (_a = asString(o.key)) === null || _a === void 0 ? void 0 : _a.trim();
        if (!key) {
            continue;
        }
        const loc = asString(o.location);
        const location = loc === 'body' || loc === 'path' ? loc : 'query';
        const t = asString(o.type);
        const type = t === 'number' || t === 'boolean' ? t : 'string';
        const spec = {
            key,
            label: ((_b = asString(o.label)) === null || _b === void 0 ? void 0 : _b.trim()) || key,
            description: ((_c = asString(o.description)) === null || _c === void 0 ? void 0 : _c.trim()) || key,
            type,
            required: o.required === true || o.required === 'true',
            location,
        };
        const def = asString(o.default);
        if (def !== undefined) {
            spec.default = def;
        }
        out.push(spec);
    }
    return out;
}
/**
 * Normalise a static query/body argument into a flat string→string map.
 * Accepts either an object or a JSON string (LLMs frequently send the latter).
 */
function asStringMap(value) {
    let raw = value;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            raw = JSON.parse(raw);
        }
        catch {
            return undefined;
        }
    }
    const obj = asObject(raw);
    if (!obj) {
        return undefined;
    }
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined && v !== null) {
            out[k] = String(v);
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
let RunTerminalCommandToolProvider = RunTerminalCommandToolProvider_1 = class RunTerminalCommandToolProvider {
    getTool() {
        return {
            id: RunTerminalCommandToolProvider_1.ID,
            name: RunTerminalCommandToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Run a shell command on the host from the project root and return its '
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
                var _a;
                const command = (_a = asString(parseArgs(args).command)) !== null && _a !== void 0 ? _a : '';
                return { label: command.slice(0, 60), hasMore: command.length > 60 };
            },
            handler: async (argString) => {
                const args = parseArgs(argString);
                const command = asString(args.command);
                if (!command) {
                    return 'Error: "command" is required.';
                }
                const cwd = asString(args.cwd);
                const result = await this.configPlane.executeCommand(command, cwd);
                const parts = [];
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
};
exports.RunTerminalCommandToolProvider = RunTerminalCommandToolProvider;
RunTerminalCommandToolProvider.ID = 'cc_runTerminalCommand';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], RunTerminalCommandToolProvider.prototype, "configPlane", void 0);
exports.RunTerminalCommandToolProvider = RunTerminalCommandToolProvider = RunTerminalCommandToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], RunTerminalCommandToolProvider);
// ---------------------------------------------------------------------------
// Web fetch
// ---------------------------------------------------------------------------
let FetchWebpageToolProvider = FetchWebpageToolProvider_1 = class FetchWebpageToolProvider {
    getTool() {
        return {
            id: FetchWebpageToolProvider_1.ID,
            name: FetchWebpageToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Fetch the content of a web page or HTTP(S) URL and return its body as text. '
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
                var _a;
                const url = (_a = asString(parseArgs(args).url)) !== null && _a !== void 0 ? _a : '';
                return { label: url.slice(0, 60), hasMore: url.length > 60 };
            },
            handler: async (argString) => {
                const url = asString(parseArgs(argString).url);
                if (!url) {
                    return 'Error: "url" is required.';
                }
                try {
                    const result = await this.configPlane.fetchUrl(url);
                    const header = `HTTP ${result.status} · ${result.contentType || 'unknown content-type'}`
                        + (result.truncated ? ' · (body truncated)' : '');
                    return `${header}\n\n${result.body}`;
                }
                catch (err) {
                    return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.FetchWebpageToolProvider = FetchWebpageToolProvider;
FetchWebpageToolProvider.ID = 'cc_fetchWebpage';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], FetchWebpageToolProvider.prototype, "configPlane", void 0);
exports.FetchWebpageToolProvider = FetchWebpageToolProvider = FetchWebpageToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], FetchWebpageToolProvider);
// ---------------------------------------------------------------------------
// Open link
// ---------------------------------------------------------------------------
let OpenLinkToolProvider = OpenLinkToolProvider_1 = class OpenLinkToolProvider {
    getTool() {
        return {
            id: OpenLinkToolProvider_1.ID,
            name: OpenLinkToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Open a URL in a new browser tab/window for the user to view. '
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
                var _a;
                const url = (_a = asString(parseArgs(args).url)) !== null && _a !== void 0 ? _a : '';
                return { label: url.slice(0, 60), hasMore: url.length > 60 };
            },
            handler: async (argString) => {
                const url = asString(parseArgs(argString).url);
                if (!url) {
                    return 'Error: "url" is required.';
                }
                this.windowService.openNewWindow(url, { external: true });
                return `Opened ${url} in a new window.`;
            }
        };
    }
};
exports.OpenLinkToolProvider = OpenLinkToolProvider;
OpenLinkToolProvider.ID = 'cc_openLink';
__decorate([
    (0, inversify_1.inject)(window_service_1.WindowService),
    __metadata("design:type", Object)
], OpenLinkToolProvider.prototype, "windowService", void 0);
exports.OpenLinkToolProvider = OpenLinkToolProvider = OpenLinkToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], OpenLinkToolProvider);
// ---------------------------------------------------------------------------
// Read file
// ---------------------------------------------------------------------------
let ReadFileToolProvider = ReadFileToolProvider_1 = class ReadFileToolProvider {
    getTool() {
        return {
            id: ReadFileToolProvider_1.ID,
            name: ReadFileToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Read the UTF-8 text content of a file in the project, given a path relative to '
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
                var _a;
                const path = (_a = asString(parseArgs(args).path)) !== null && _a !== void 0 ? _a : '';
                return { label: path.slice(0, 60), hasMore: path.length > 60 };
            },
            handler: async (argString) => {
                const filePath = asString(parseArgs(argString).path);
                if (!filePath) {
                    return 'Error: "path" is required.';
                }
                try {
                    return await this.configPlane.readProjectFile(filePath);
                }
                catch (err) {
                    return `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.ReadFileToolProvider = ReadFileToolProvider;
ReadFileToolProvider.ID = 'cc_readFile';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ReadFileToolProvider.prototype, "configPlane", void 0);
exports.ReadFileToolProvider = ReadFileToolProvider = ReadFileToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ReadFileToolProvider);
// ---------------------------------------------------------------------------
// Write file
// ---------------------------------------------------------------------------
let WriteFileToolProvider = WriteFileToolProvider_1 = class WriteFileToolProvider {
    getTool() {
        return {
            id: WriteFileToolProvider_1.ID,
            name: WriteFileToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Write (create or overwrite) a UTF-8 text file in the project, given a path '
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
                var _a;
                const path = (_a = asString(parseArgs(args).path)) !== null && _a !== void 0 ? _a : '';
                return { label: path.slice(0, 60), hasMore: path.length > 60 };
            },
            handler: async (argString) => {
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
                }
                catch (err) {
                    return `Error writing ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.WriteFileToolProvider = WriteFileToolProvider;
WriteFileToolProvider.ID = 'cc_writeFile';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], WriteFileToolProvider.prototype, "configPlane", void 0);
exports.WriteFileToolProvider = WriteFileToolProvider = WriteFileToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], WriteFileToolProvider);
// ---------------------------------------------------------------------------
// List files
// ---------------------------------------------------------------------------
let ListFilesToolProvider = ListFilesToolProvider_1 = class ListFilesToolProvider {
    getTool() {
        return {
            id: ListFilesToolProvider_1.ID,
            name: ListFilesToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'List the files and directories inside a project directory, given a path '
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
                var _a;
                const path = (_a = asString(parseArgs(args).path)) !== null && _a !== void 0 ? _a : '.';
                return { label: path.slice(0, 60), hasMore: path.length > 60 };
            },
            handler: async (argString) => {
                var _a;
                const dir = (_a = asString(parseArgs(argString).path)) !== null && _a !== void 0 ? _a : '.';
                try {
                    const entries = await this.configPlane.listProjectFiles(dir);
                    if (entries.length === 0) {
                        return `(empty) ${dir}`;
                    }
                    return entries
                        .map(e => (e.type === 'directory' ? `${e.name}/` : e.name))
                        .join('\n');
                }
                catch (err) {
                    return `Error listing ${dir}: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.ListFilesToolProvider = ListFilesToolProvider;
ListFilesToolProvider.ID = 'cc_listFiles';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ListFilesToolProvider.prototype, "configPlane", void 0);
exports.ListFilesToolProvider = ListFilesToolProvider = ListFilesToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ListFilesToolProvider);
// ---------------------------------------------------------------------------
// Integrations: list supported kinds + their field schemas
// ---------------------------------------------------------------------------
let ListIntegrationKindsToolProvider = ListIntegrationKindsToolProvider_1 = class ListIntegrationKindsToolProvider {
    getTool() {
        return {
            id: ListIntegrationKindsToolProvider_1.ID,
            name: ListIntegrationKindsToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'List the kinds of integrations that can be configured (MCP servers, APIs, webhooks, '
                + 'infrastructure) together with the exact fields each one needs. Call this FIRST when '
                + 'helping a user set up an integration, so you know which values and secrets to collect.',
            parameters: { type: 'object', properties: {}, required: [] },
            handler: async () => {
                const specs = await this.configPlane.getKindSpecs();
                return JSON.stringify(specs, undefined, 2);
            }
        };
    }
};
exports.ListIntegrationKindsToolProvider = ListIntegrationKindsToolProvider;
ListIntegrationKindsToolProvider.ID = 'cc_listIntegrationKinds';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ListIntegrationKindsToolProvider.prototype, "configPlane", void 0);
exports.ListIntegrationKindsToolProvider = ListIntegrationKindsToolProvider = ListIntegrationKindsToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ListIntegrationKindsToolProvider);
// ---------------------------------------------------------------------------
// Integrations: list existing records
// ---------------------------------------------------------------------------
let ListIntegrationsToolProvider = ListIntegrationsToolProvider_1 = class ListIntegrationsToolProvider {
    getTool() {
        return {
            id: ListIntegrationsToolProvider_1.ID,
            name: ListIntegrationsToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'List the integrations currently configured (secret values are never returned, only '
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
};
exports.ListIntegrationsToolProvider = ListIntegrationsToolProvider;
ListIntegrationsToolProvider.ID = 'cc_listIntegrations';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ListIntegrationsToolProvider.prototype, "configPlane", void 0);
exports.ListIntegrationsToolProvider = ListIntegrationsToolProvider = ListIntegrationsToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ListIntegrationsToolProvider);
// ---------------------------------------------------------------------------
// Integrations: create
// ---------------------------------------------------------------------------
let CreateIntegrationToolProvider = CreateIntegrationToolProvider_1 = class CreateIntegrationToolProvider {
    getTool() {
        return {
            id: CreateIntegrationToolProvider_1.ID,
            name: CreateIntegrationToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Create a new integration once you have collected the required values from the user. '
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
                var _a, _b;
                const a = parseArgs(args);
                const label = `${(_a = asString(a.kind)) !== null && _a !== void 0 ? _a : ''}: ${(_b = asString(a.name)) !== null && _b !== void 0 ? _b : ''}`.trim();
                return { label: label.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const a = parseArgs(argString);
                const kind = asString(a.kind);
                const name = asString(a.name);
                if (!kind || !name) {
                    return 'Error: "kind" and "name" are required.';
                }
                const draft = {
                    kind: kind,
                    name,
                    description: asString(a.description),
                    values: (a.values && typeof a.values === 'object') ? a.values : undefined,
                    secrets: (a.secrets && typeof a.secrets === 'object') ? a.secrets : undefined,
                    enabled: typeof a.enabled === 'boolean' ? a.enabled : undefined
                };
                try {
                    const record = await this.configPlane.createIntegration(draft);
                    return `Created integration '${record.name}' (id: ${record.id}, kind: ${record.kind}). `
                        + `Secrets set: ${record.secretsSet.length ? record.secretsSet.join(', ') : 'none'}. `
                        + `Run cc_testIntegration with id "${record.id}" to verify the connection.`;
                }
                catch (err) {
                    return `Error creating integration: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.CreateIntegrationToolProvider = CreateIntegrationToolProvider;
CreateIntegrationToolProvider.ID = 'cc_createIntegration';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], CreateIntegrationToolProvider.prototype, "configPlane", void 0);
exports.CreateIntegrationToolProvider = CreateIntegrationToolProvider = CreateIntegrationToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], CreateIntegrationToolProvider);
// ---------------------------------------------------------------------------
// Integrations: update
// ---------------------------------------------------------------------------
let UpdateIntegrationToolProvider = UpdateIntegrationToolProvider_1 = class UpdateIntegrationToolProvider {
    getTool() {
        return {
            id: UpdateIntegrationToolProvider_1.ID,
            name: UpdateIntegrationToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Update an existing integration by id. Only the fields you provide are changed. Use this '
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
                var _a;
                const id = (_a = asString(parseArgs(args).id)) !== null && _a !== void 0 ? _a : '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const a = parseArgs(argString);
                const id = asString(a.id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                const patch = {
                    name: asString(a.name),
                    description: asString(a.description),
                    values: (a.values && typeof a.values === 'object') ? a.values : undefined,
                    secrets: (a.secrets && typeof a.secrets === 'object') ? a.secrets : undefined,
                    enabled: typeof a.enabled === 'boolean' ? a.enabled : undefined
                };
                try {
                    const record = await this.configPlane.updateIntegration(id, patch);
                    return `Updated integration '${record.name}' (id: ${record.id}).`;
                }
                catch (err) {
                    return `Error updating integration: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.UpdateIntegrationToolProvider = UpdateIntegrationToolProvider;
UpdateIntegrationToolProvider.ID = 'cc_updateIntegration';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], UpdateIntegrationToolProvider.prototype, "configPlane", void 0);
exports.UpdateIntegrationToolProvider = UpdateIntegrationToolProvider = UpdateIntegrationToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], UpdateIntegrationToolProvider);
// ---------------------------------------------------------------------------
// Integrations: test connection
// ---------------------------------------------------------------------------
let TestIntegrationToolProvider = TestIntegrationToolProvider_1 = class TestIntegrationToolProvider {
    getTool() {
        return {
            id: TestIntegrationToolProvider_1.ID,
            name: TestIntegrationToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Test the connectivity of a configured integration by id (an authenticated request to an '
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
                var _a;
                const id = (_a = asString(parseArgs(args).id)) !== null && _a !== void 0 ? _a : '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const id = asString(parseArgs(argString).id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                try {
                    const result = await this.configPlane.testIntegration(id);
                    const prefix = result.ok ? 'OK' : 'FAILED';
                    const status = result.status !== undefined ? ` (HTTP ${result.status})` : '';
                    return `${prefix}${status}: ${result.message}`;
                }
                catch (err) {
                    return `Error testing integration: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.TestIntegrationToolProvider = TestIntegrationToolProvider;
TestIntegrationToolProvider.ID = 'cc_testIntegration';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], TestIntegrationToolProvider.prototype, "configPlane", void 0);
exports.TestIntegrationToolProvider = TestIntegrationToolProvider = TestIntegrationToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], TestIntegrationToolProvider);
// ---------------------------------------------------------------------------
// Integrations: OAuth 2.0 — start authorization-code consent
// ---------------------------------------------------------------------------
let StartOAuthToolProvider = StartOAuthToolProvider_1 = class StartOAuthToolProvider {
    getTool() {
        return {
            id: StartOAuthToolProvider_1.ID,
            name: StartOAuthToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Begin the OAuth 2.0 authorization-code flow for an API integration whose authType is '
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
                var _a;
                const id = (_a = asString(parseArgs(args).id)) !== null && _a !== void 0 ? _a : '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const id = asString(parseArgs(argString).id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                try {
                    const info = await this.configPlane.startOAuth(id);
                    return `Open this URL to authorize:\n${info.authorizationUrl}\n\n${info.instructions}`;
                }
                catch (err) {
                    return `Error starting OAuth: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.StartOAuthToolProvider = StartOAuthToolProvider;
StartOAuthToolProvider.ID = 'cc_startOAuth';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], StartOAuthToolProvider.prototype, "configPlane", void 0);
exports.StartOAuthToolProvider = StartOAuthToolProvider = StartOAuthToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], StartOAuthToolProvider);
// ---------------------------------------------------------------------------
// Integrations: OAuth 2.0 — exchange authorization code for tokens
// ---------------------------------------------------------------------------
let CompleteOAuthToolProvider = CompleteOAuthToolProvider_1 = class CompleteOAuthToolProvider {
    getTool() {
        return {
            id: CompleteOAuthToolProvider_1.ID,
            name: CompleteOAuthToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Finish the OAuth 2.0 authorization-code flow by exchanging the "code" the user copied from '
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
                var _a;
                const id = (_a = asString(parseArgs(args).id)) !== null && _a !== void 0 ? _a : '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
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
                }
                catch (err) {
                    return `Error completing OAuth: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.CompleteOAuthToolProvider = CompleteOAuthToolProvider;
CompleteOAuthToolProvider.ID = 'cc_completeOAuth';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], CompleteOAuthToolProvider.prototype, "configPlane", void 0);
exports.CompleteOAuthToolProvider = CompleteOAuthToolProvider = CompleteOAuthToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], CompleteOAuthToolProvider);
// ---------------------------------------------------------------------------
// Integrations: OAuth 2.0 — obtain / refresh an access token
// ---------------------------------------------------------------------------
let RefreshOAuthToolProvider = RefreshOAuthToolProvider_1 = class RefreshOAuthToolProvider {
    getTool() {
        return {
            id: RefreshOAuthToolProvider_1.ID,
            name: RefreshOAuthToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Obtain or renew an OAuth 2.0 access token without user interaction. For '
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
                var _a;
                const id = (_a = asString(parseArgs(args).id)) !== null && _a !== void 0 ? _a : '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const id = asString(parseArgs(argString).id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                try {
                    const result = await this.configPlane.refreshOAuthToken(id);
                    const prefix = result.ok ? 'OK' : 'FAILED';
                    return `${prefix}: ${result.message}`;
                }
                catch (err) {
                    return `Error refreshing OAuth token: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.RefreshOAuthToolProvider = RefreshOAuthToolProvider;
RefreshOAuthToolProvider.ID = 'cc_refreshOAuth';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], RefreshOAuthToolProvider.prototype, "configPlane", void 0);
exports.RefreshOAuthToolProvider = RefreshOAuthToolProvider = RefreshOAuthToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], RefreshOAuthToolProvider);
/**
 * Lists every skill available to agents (name, domain, description and
 * when-to-use), scanned from the repo skill folders and `~/.theia/skills`.
 */
let ListSkillsToolProvider = ListSkillsToolProvider_1 = class ListSkillsToolProvider {
    getTool() {
        return {
            id: ListSkillsToolProvider_1.ID,
            name: ListSkillsToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'List the skills (reusable, step-by-step procedures) available to you. Returns each '
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
                }
                catch (err) {
                    return `Error listing skills: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.ListSkillsToolProvider = ListSkillsToolProvider;
ListSkillsToolProvider.ID = 'cc_listSkills';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ListSkillsToolProvider.prototype, "configPlane", void 0);
exports.ListSkillsToolProvider = ListSkillsToolProvider = ListSkillsToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ListSkillsToolProvider);
/**
 * Loads the full instruction body of a single skill by name, so the agent can
 * follow its detailed steps (progressive disclosure).
 */
let UseSkillToolProvider = UseSkillToolProvider_1 = class UseSkillToolProvider {
    getTool() {
        return {
            id: UseSkillToolProvider_1.ID,
            name: UseSkillToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Load the full instructions for a skill by name (as listed by cc_listSkills). '
                + 'Returns the skill\'s complete step-by-step procedure, which you should then follow precisely.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The skill name to load (e.g. "deal_followup_draft").' }
                },
                required: ['name']
            },
            getArgumentsShortLabel: args => {
                var _a;
                const name = (_a = asString(parseArgs(args).name)) !== null && _a !== void 0 ? _a : '';
                return { label: name.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const name = asString(parseArgs(argString).name);
                if (!name) {
                    return 'Error: "name" is required.';
                }
                try {
                    const body = await this.configPlane.getSkill(name);
                    return `# Skill: ${name}\n\n${body}`;
                }
                catch (err) {
                    return `Error loading skill: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.UseSkillToolProvider = UseSkillToolProvider;
UseSkillToolProvider.ID = 'cc_useSkill';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], UseSkillToolProvider.prototype, "configPlane", void 0);
exports.UseSkillToolProvider = UseSkillToolProvider = UseSkillToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], UseSkillToolProvider);
// ---------------------------------------------------------------------------
// Agent feedback: read
// ---------------------------------------------------------------------------
/**
 * Loads the recent feedback log for an agent.
 * Used by the Reflector agent to analyse patterns and propose directives.
 */
let ReadAgentFeedbackToolProvider = ReadAgentFeedbackToolProvider_1 = class ReadAgentFeedbackToolProvider {
    getTool() {
        return {
            id: ReadAgentFeedbackToolProvider_1.ID,
            name: ReadAgentFeedbackToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Load the recent thumbs-up/thumbs-down feedback for a specific agent. '
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
                var _a;
                const id = (_a = asString(parseArgs(args).agentId)) !== null && _a !== void 0 ? _a : '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const agentId = asString(parseArgs(argString).agentId);
                if (!agentId) {
                    return 'Error: "agentId" is required.';
                }
                try {
                    const feedback = await this.configPlane.listFeedback(agentId);
                    if (feedback.length === 0) {
                        return `No feedback recorded yet for agent '${agentId}'.`;
                    }
                    const recent = feedback.slice(-50);
                    const pos = recent.filter(f => f.signal === 'positive').length;
                    const neg = recent.filter(f => f.signal === 'negative').length;
                    const entries = recent.map(f => `[${f.createdAt.slice(0, 16)}] ${f.signal === 'positive' ? '+1' : '-1'}${f.note ? ` — "${f.note}"` : ''}`).join('\n');
                    return `Agent: ${agentId} | Total: ${recent.length} | Positive: ${pos} | Negative: ${neg}\n\n${entries}`;
                }
                catch (err) {
                    return `Error reading feedback: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.ReadAgentFeedbackToolProvider = ReadAgentFeedbackToolProvider;
ReadAgentFeedbackToolProvider.ID = 'cc_readFeedback';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ReadAgentFeedbackToolProvider.prototype, "configPlane", void 0);
exports.ReadAgentFeedbackToolProvider = ReadAgentFeedbackToolProvider = ReadAgentFeedbackToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ReadAgentFeedbackToolProvider);
// ---------------------------------------------------------------------------
// Agent directives: propose (used by Reflector)
// ---------------------------------------------------------------------------
/**
 * Proposes a new standing directive for an agent.
 * Creates a 'pending' directive that appears in the Agents panel for review.
 */
let ProposeDirectiveToolProvider = ProposeDirectiveToolProvider_1 = class ProposeDirectiveToolProvider {
    getTool() {
        return {
            id: ProposeDirectiveToolProvider_1.ID,
            name: ProposeDirectiveToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Propose a new standing directive for an agent based on observed feedback patterns. '
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
                var _a, _b;
                const a = parseArgs(args);
                const label = `${(_a = asString(a.agentId)) !== null && _a !== void 0 ? _a : ''}: ${(_b = asString(a.text)) !== null && _b !== void 0 ? _b : ''}`.trim();
                return { label: label.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const a = parseArgs(argString);
                const agentId = asString(a.agentId);
                const text = asString(a.text);
                if (!agentId || !text) {
                    return 'Error: "agentId" and "text" are required.';
                }
                try {
                    const directive = await this.configPlane.addDirective(agentId, text, 'reflector');
                    return `Directive proposed (id: ${directive.id}, status: pending): "${directive.text}"\n`
                        + `It will appear in the Agents panel under "${agentId}" for review.`;
                }
                catch (err) {
                    return `Error proposing directive: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.ProposeDirectiveToolProvider = ProposeDirectiveToolProvider;
ProposeDirectiveToolProvider.ID = 'cc_proposeDirective';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ProposeDirectiveToolProvider.prototype, "configPlane", void 0);
exports.ProposeDirectiveToolProvider = ProposeDirectiveToolProvider = ProposeDirectiveToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ProposeDirectiveToolProvider);
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
function describeAgent(a) {
    var _a, _b, _c, _d;
    const lines = [];
    lines.push(`### ${a.name} (id: ${a.id})${a.builtin ? ' [built-in]' : ''}`);
    lines.push(`- description: ${a.description}`);
    lines.push(`- model: ${a.defaultLLM}`);
    lines.push(`- showInChat: ${a.showInChat}`);
    if ((_a = a.skills) === null || _a === void 0 ? void 0 : _a.length) {
        lines.push(`- skills: ${a.skills.join(', ')}`);
    }
    if ((_b = a.tools) === null || _b === void 0 ? void 0 : _b.length) {
        lines.push(`- tools: ${a.tools.join(', ')}`);
    }
    if (a.soul) {
        const s = a.soul;
        const parts = [
            s.role ? `role="${s.role}"` : '',
            s.domain ? `domain="${s.domain}"` : '',
            s.persona ? `persona="${s.persona}"` : '',
            ((_c = s.coreValues) === null || _c === void 0 ? void 0 : _c.length) ? `values=[${s.coreValues.join('; ')}]` : '',
        ].filter(Boolean);
        if (parts.length) {
            lines.push(`- soul: ${parts.join(', ')}`);
        }
    }
    const directives = (_d = a.directives) !== null && _d !== void 0 ? _d : [];
    if (directives.length) {
        lines.push(`- directives (${directives.length}):`);
        for (const d of directives) {
            lines.push(`    [${d.status}] (${d.source}, id: ${d.id}) ${d.text}`);
        }
    }
    if (a.promptVersion) {
        lines.push(`- promptVersion: ${a.promptVersion}`);
    }
    return lines.join('\n');
}
/** Build an {@link AgentSoul} from loose tool arguments, or undefined. */
function buildSoul(value) {
    const obj = asObject(value);
    if (!obj) {
        return undefined;
    }
    const soul = {};
    if (asString(obj.role)) {
        soul.role = asString(obj.role);
    }
    if (asString(obj.domain)) {
        soul.domain = asString(obj.domain);
    }
    if (asString(obj.persona)) {
        soul.persona = asString(obj.persona);
    }
    const values = asStringArray(obj.coreValues);
    if (values) {
        soul.coreValues = values;
    }
    return Object.keys(soul).length ? soul : undefined;
}
/**
 * Lists every agent with its core configuration (model, soul, skills,
 * directive summary). The entry point for self-annealing — call this first to
 * discover agent ids before inspecting or editing one.
 */
let ListAgentsToolProvider = ListAgentsToolProvider_1 = class ListAgentsToolProvider {
    getTool() {
        return {
            id: ListAgentsToolProvider_1.ID,
            name: ListAgentsToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'List all configured agents with their id, name, description, model, soul, assigned '
                + 'skills and directive summary (the full system prompt is omitted — use cc_getAgent '
                + 'for that). Call this first when asked to inspect, edit or improve any agent, including yourself.',
            parameters: { type: 'object', properties: {}, required: [] },
            handler: async () => {
                try {
                    const agents = await this.configPlane.listAgents();
                    if (agents.length === 0) {
                        return 'No agents are configured yet.';
                    }
                    return agents.map(describeAgent).join('\n\n');
                }
                catch (err) {
                    return `Error listing agents: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.ListAgentsToolProvider = ListAgentsToolProvider;
ListAgentsToolProvider.ID = 'cc_listAgents';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ListAgentsToolProvider.prototype, "configPlane", void 0);
exports.ListAgentsToolProvider = ListAgentsToolProvider = ListAgentsToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ListAgentsToolProvider);
/** Returns one agent's complete definition, including its full system prompt. */
let GetAgentToolProvider = GetAgentToolProvider_1 = class GetAgentToolProvider {
    getTool() {
        return {
            id: GetAgentToolProvider_1.ID,
            name: GetAgentToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Get the complete definition of a single agent by id, INCLUDING its full system prompt, '
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
                var _a;
                const id = (_a = asString(parseArgs(args).id)) !== null && _a !== void 0 ? _a : '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const id = asString(parseArgs(argString).id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                try {
                    const agents = await this.configPlane.listAgents();
                    const agent = agents.find(a => a.id === id);
                    if (!agent) {
                        return `Agent '${id}' not found. Known ids: ${agents.map(a => a.id).join(', ') || '(none)'}.`;
                    }
                    return `${describeAgent(agent)}\n\n--- system prompt ---\n${agent.prompt}`;
                }
                catch (err) {
                    return `Error getting agent: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.GetAgentToolProvider = GetAgentToolProvider;
GetAgentToolProvider.ID = 'cc_getAgent';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], GetAgentToolProvider.prototype, "configPlane", void 0);
exports.GetAgentToolProvider = GetAgentToolProvider = GetAgentToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], GetAgentToolProvider);
/** Creates a new specialised agent from a name, description and system prompt. */
let CreateAgentToolProvider = CreateAgentToolProvider_1 = class CreateAgentToolProvider {
    getTool() {
        return {
            id: CreateAgentToolProvider_1.ID,
            name: CreateAgentToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Create a new specialised agent. Provide a "name", a one-sentence "description" and a '
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
                var _a;
                const name = (_a = asString(parseArgs(args).name)) !== null && _a !== void 0 ? _a : '';
                return { label: name.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const a = parseArgs(argString);
                const name = asString(a.name);
                const description = asString(a.description);
                const prompt = asString(a.prompt);
                if (!name || !description || !prompt) {
                    return 'Error: "name", "description" and "prompt" are all required.';
                }
                const draft = {
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
                }
                catch (err) {
                    return `Error creating agent: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.CreateAgentToolProvider = CreateAgentToolProvider;
CreateAgentToolProvider.ID = 'cc_createAgent';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], CreateAgentToolProvider.prototype, "configPlane", void 0);
exports.CreateAgentToolProvider = CreateAgentToolProvider = CreateAgentToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], CreateAgentToolProvider);
/** Edits an existing agent: prompt, model, soul, skills, visibility, name. */
let UpdateAgentToolProvider = UpdateAgentToolProvider_1 = class UpdateAgentToolProvider {
    getTool() {
        return {
            id: UpdateAgentToolProvider_1.ID,
            name: UpdateAgentToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Update an existing agent by id — including yourself. Only the fields you provide change; '
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
                var _a;
                const id = (_a = asString(parseArgs(args).id)) !== null && _a !== void 0 ? _a : '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                var _a;
                const a = parseArgs(argString);
                const id = asString(a.id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                const patch = {
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
                        + `Current model: ${agent.defaultLLM}, promptVersion: ${(_a = agent.promptVersion) !== null && _a !== void 0 ? _a : 1}. `
                        + `Changes apply on the next message turn.`;
                }
                catch (err) {
                    return `Error updating agent: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.UpdateAgentToolProvider = UpdateAgentToolProvider;
UpdateAgentToolProvider.ID = 'cc_updateAgent';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], UpdateAgentToolProvider.prototype, "configPlane", void 0);
exports.UpdateAgentToolProvider = UpdateAgentToolProvider = UpdateAgentToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], UpdateAgentToolProvider);
/** Permanently deletes a custom (non built-in) agent. */
let DeleteAgentToolProvider = DeleteAgentToolProvider_1 = class DeleteAgentToolProvider {
    getTool() {
        return {
            id: DeleteAgentToolProvider_1.ID,
            name: DeleteAgentToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Permanently delete a custom agent by id. Built-in agents (assistant, agent-creator, reflector) '
                + 'cannot be deleted. This is irreversible — confirm with the user before calling it.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The id of the custom agent to delete.' }
                },
                required: ['id']
            },
            getArgumentsShortLabel: args => {
                var _a;
                const id = (_a = asString(parseArgs(args).id)) !== null && _a !== void 0 ? _a : '';
                return { label: id.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const id = asString(parseArgs(argString).id);
                if (!id) {
                    return 'Error: "id" is required.';
                }
                try {
                    await this.configPlane.deleteAgent(id);
                    return `Deleted agent '${id}'.`;
                }
                catch (err) {
                    return `Error deleting agent: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.DeleteAgentToolProvider = DeleteAgentToolProvider;
DeleteAgentToolProvider.ID = 'cc_deleteAgent';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], DeleteAgentToolProvider.prototype, "configPlane", void 0);
exports.DeleteAgentToolProvider = DeleteAgentToolProvider = DeleteAgentToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], DeleteAgentToolProvider);
/**
 * Adds a standing directive to an agent. Unlike cc_proposeDirective (which
 * submits a *pending* Reflector proposal), this adds an immediately-active rule.
 */
let AddDirectiveToolProvider = AddDirectiveToolProvider_1 = class AddDirectiveToolProvider {
    getTool() {
        return {
            id: AddDirectiveToolProvider_1.ID,
            name: AddDirectiveToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Add an immediately-active standing directive to an agent (including yourself). The directive '
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
                var _a, _b;
                const a = parseArgs(args);
                return { label: `${(_a = asString(a.agentId)) !== null && _a !== void 0 ? _a : ''}: ${(_b = asString(a.text)) !== null && _b !== void 0 ? _b : ''}`.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const a = parseArgs(argString);
                const agentId = asString(a.agentId);
                const text = asString(a.text);
                if (!agentId || !text) {
                    return 'Error: "agentId" and "text" are required.';
                }
                try {
                    const directive = await this.configPlane.addDirective(agentId, text, 'manual');
                    return `Added active directive (id: ${directive.id}) to '${agentId}': "${directive.text}"`;
                }
                catch (err) {
                    return `Error adding directive: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.AddDirectiveToolProvider = AddDirectiveToolProvider;
AddDirectiveToolProvider.ID = 'cc_addDirective';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], AddDirectiveToolProvider.prototype, "configPlane", void 0);
exports.AddDirectiveToolProvider = AddDirectiveToolProvider = AddDirectiveToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], AddDirectiveToolProvider);
/** Approves, rejects, updates or removes an existing directive on an agent. */
let ManageDirectiveToolProvider = ManageDirectiveToolProvider_1 = class ManageDirectiveToolProvider {
    getTool() {
        return {
            id: ManageDirectiveToolProvider_1.ID,
            name: ManageDirectiveToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Manage an existing directive on an agent. "action" is one of: "approve" (promote a pending '
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
                var _a, _b;
                const a = parseArgs(args);
                return { label: `${(_a = asString(a.action)) !== null && _a !== void 0 ? _a : ''} ${(_b = asString(a.directiveId)) !== null && _b !== void 0 ? _b : ''}`.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
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
                            if (!text) {
                                return 'Error: "text" is required when action is "update".';
                            }
                            const d = await this.configPlane.updateDirective(agentId, directiveId, text);
                            return `Updated directive ${d.id} on '${agentId}': "${d.text}"`;
                        }
                        default:
                            return `Error: unknown action "${action}". Use approve, reject, remove or update.`;
                    }
                }
                catch (err) {
                    return `Error managing directive: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.ManageDirectiveToolProvider = ManageDirectiveToolProvider;
ManageDirectiveToolProvider.ID = 'cc_manageDirective';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ManageDirectiveToolProvider.prototype, "configPlane", void 0);
exports.ManageDirectiveToolProvider = ManageDirectiveToolProvider = ManageDirectiveToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ManageDirectiveToolProvider);
/** Creates or overwrites a reusable skill (SKILL.md) authored from chat. */
let WriteSkillToolProvider = WriteSkillToolProvider_1 = class WriteSkillToolProvider {
    getTool() {
        return {
            id: WriteSkillToolProvider_1.ID,
            name: WriteSkillToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Create or update a reusable skill (a packaged, step-by-step procedure). Provide a "name", a '
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
                var _a;
                const name = (_a = asString(parseArgs(args).name)) !== null && _a !== void 0 ? _a : '';
                return { label: name.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const a = parseArgs(argString);
                const name = asString(a.name);
                const description = asString(a.description);
                const body = asString(a.body);
                if (!name || !description || !body) {
                    return 'Error: "name", "description" and "body" are all required.';
                }
                const draft = {
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
                }
                catch (err) {
                    return `Error writing skill: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.WriteSkillToolProvider = WriteSkillToolProvider;
WriteSkillToolProvider.ID = 'cc_writeSkill';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], WriteSkillToolProvider.prototype, "configPlane", void 0);
exports.WriteSkillToolProvider = WriteSkillToolProvider = WriteSkillToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], WriteSkillToolProvider);
/** Deletes a user-authored skill. */
let DeleteSkillToolProvider = DeleteSkillToolProvider_1 = class DeleteSkillToolProvider {
    getTool() {
        return {
            id: DeleteSkillToolProvider_1.ID,
            name: DeleteSkillToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Permanently delete a user-authored skill by name. Only skills stored in the user skills '
                + 'directory can be removed; repo-bundled skills are read-only. Irreversible — confirm first.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The skill name to delete.' }
                },
                required: ['name']
            },
            getArgumentsShortLabel: args => {
                var _a;
                const name = (_a = asString(parseArgs(args).name)) !== null && _a !== void 0 ? _a : '';
                return { label: name.slice(0, 60), hasMore: false };
            },
            handler: async (argString) => {
                const name = asString(parseArgs(argString).name);
                if (!name) {
                    return 'Error: "name" is required.';
                }
                try {
                    await this.configPlane.deleteSkill(name);
                    return `Deleted skill '${name}'.`;
                }
                catch (err) {
                    return `Error deleting skill: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.DeleteSkillToolProvider = DeleteSkillToolProvider;
DeleteSkillToolProvider.ID = 'cc_deleteSkill';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], DeleteSkillToolProvider.prototype, "configPlane", void 0);
exports.DeleteSkillToolProvider = DeleteSkillToolProvider = DeleteSkillToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], DeleteSkillToolProvider);
// ---------------------------------------------------------------------------
// Call Integration — authenticated HTTP requests against configured APIs
// ---------------------------------------------------------------------------
/**
 * Makes an authenticated HTTP request to a configured `api` integration.
 * Auth headers (Bearer token, API key, Basic, or OAuth access token with
 * auto-refresh) are applied automatically from the stored credentials.
 * The response body is returned as a string for the agent to parse.
 */
let CallIntegrationToolProvider = CallIntegrationToolProvider_1 = class CallIntegrationToolProvider {
    getTool() {
        return {
            id: CallIntegrationToolProvider_1.ID,
            name: CallIntegrationToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Make an authenticated HTTP request to a configured API integration. '
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
                var _a, _b;
                const { method, path } = parseArgs(args);
                const label = `${(_a = asString(method)) !== null && _a !== void 0 ? _a : '?'} ${(_b = asString(path)) !== null && _b !== void 0 ? _b : ''}`.trim();
                return { label: label.slice(0, 80), hasMore: false };
            },
            handler: async (argString) => {
                const args = parseArgs(argString);
                const id = asString(args.id);
                const method = asString(args.method);
                const path = asString(args.path);
                if (!id || !method || !path) {
                    return 'Error: "id", "method", and "path" are all required.';
                }
                const params = asObject(args.params);
                const headers = asObject(args.headers);
                const body = args.body;
                try {
                    const result = await this.configPlane.callIntegration(id, method, path, params, body, headers);
                    if (result.error) {
                        return `Error: ${result.error}`;
                    }
                    const truncNote = result.truncated ? '\n[Response truncated to 32 KB]' : '';
                    return `HTTP ${result.status}\n${result.body}${truncNote}`;
                }
                catch (err) {
                    return `Error calling integration: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.CallIntegrationToolProvider = CallIntegrationToolProvider;
CallIntegrationToolProvider.ID = 'cc_callIntegration';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], CallIntegrationToolProvider.prototype, "configPlane", void 0);
exports.CallIntegrationToolProvider = CallIntegrationToolProvider = CallIntegrationToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], CallIntegrationToolProvider);
// ---------------------------------------------------------------------------
// User-defined Tool management tool providers
// ---------------------------------------------------------------------------
let ListToolsToolProvider = ListToolsToolProvider_1 = class ListToolsToolProvider {
    getTool() {
        return {
            id: ListToolsToolProvider_1.ID,
            name: ListToolsToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'List all user-defined tools. Each tool is a named, reusable HTTP action '
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
                        var _a, _b, _c;
                        const kind = (_a = t.kind) !== null && _a !== void 0 ? _a : 'http';
                        const backing = kind === 'script'
                            ? [`kind: script (${t.runtime})`, ...(t.files && Object.keys(t.files).length ? [`files: ${Object.keys(t.files).join(', ')}`] : []), ...(((_b = t.requirements) === null || _b === void 0 ? void 0 : _b.length) ? [`requirements: ${t.requirements.join(', ')}`] : []), ...(((_c = t.integrationRefs) === null || _c === void 0 ? void 0 : _c.length) ? [`integrationRefs: ${t.integrationRefs.join(', ')}`] : [])]
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
                }
                catch (err) {
                    return `Error listing tools: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.ListToolsToolProvider = ListToolsToolProvider;
ListToolsToolProvider.ID = 'cc_listTools';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ListToolsToolProvider.prototype, "configPlane", void 0);
exports.ListToolsToolProvider = ListToolsToolProvider = ListToolsToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ListToolsToolProvider);
let SearchToolsToolProvider = SearchToolsToolProvider_1 = class SearchToolsToolProvider {
    getTool() {
        return {
            id: SearchToolsToolProvider_1.ID,
            name: SearchToolsToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Search existing user-defined tools by keyword before doing work. Matches the '
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
                var _a;
                const { query } = parseArgs(args);
                return { label: `Search tools: ${(_a = asString(query)) !== null && _a !== void 0 ? _a : ''}`, hasMore: false };
            },
            handler: async (argString) => {
                var _a;
                const args = parseArgs(argString);
                const query = ((_a = asString(args.query)) !== null && _a !== void 0 ? _a : '').trim();
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
                        var _a, _b;
                        const haystack = [
                            t.name,
                            t.description,
                            t.category,
                            t.kind === 'script' ? `script ${t.runtime} ${((_a = t.requirements) !== null && _a !== void 0 ? _a : []).join(' ')}` : `http ${t.integrationId} ${t.method} ${t.path}`,
                            t.params.map(p => p.key).join(' '),
                        ].filter(Boolean).join(' ').toLowerCase();
                        let score = 0;
                        for (const term of terms) {
                            if (t.name.toLowerCase().includes(term))
                                score += 3;
                            else if (((_b = t.category) !== null && _b !== void 0 ? _b : '').toLowerCase().includes(term))
                                score += 2;
                            else if (haystack.includes(term))
                                score += 1;
                        }
                        return { t, score };
                    }).filter(s => s.score > 0)
                        .sort((a, b) => b.score - a.score)
                        .slice(0, limit);
                    if (scored.length === 0) {
                        return `No tools match "${query}". None exists for this operation yet — create one with cc_createTool (kind="script" for programmatic work).`;
                    }
                    return scored.map(({ t }) => {
                        var _a;
                        const backing = ((_a = t.kind) !== null && _a !== void 0 ? _a : 'http') === 'script'
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
                }
                catch (err) {
                    return `Error searching tools: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.SearchToolsToolProvider = SearchToolsToolProvider;
SearchToolsToolProvider.ID = 'cc_searchTools';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], SearchToolsToolProvider.prototype, "configPlane", void 0);
exports.SearchToolsToolProvider = SearchToolsToolProvider = SearchToolsToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], SearchToolsToolProvider);
let CreateToolToolProvider = CreateToolToolProvider_1 = class CreateToolToolProvider {
    getTool() {
        return {
            id: CreateToolToolProvider_1.ID,
            name: CreateToolToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Create a reusable named tool agents invoke via cc_executeTool. Two kinds: '
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
                        description: 'JSON array string of the parameters the agent supplies at call time. Each '
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
                var _a;
                const { name } = parseArgs(args);
                return { label: `Create tool: ${(_a = asString(name)) !== null && _a !== void 0 ? _a : '?'}`, hasMore: false };
            },
            handler: async (argString) => {
                var _a, _b;
                const args = parseArgs(argString);
                const name = asString(args.name);
                const description = (_a = asString(args.description)) !== null && _a !== void 0 ? _a : '';
                if (!name) {
                    return 'Error: name is required.';
                }
                const kind = asString(args.kind) === 'script' ? 'script' : 'http';
                try {
                    if (kind === 'script') {
                        const runtime = asString(args.runtime);
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
                    const method = ((_b = asString(args.method)) !== null && _b !== void 0 ? _b : 'GET');
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
                }
                catch (err) {
                    return `Error creating tool: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.CreateToolToolProvider = CreateToolToolProvider;
CreateToolToolProvider.ID = 'cc_createTool';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], CreateToolToolProvider.prototype, "configPlane", void 0);
exports.CreateToolToolProvider = CreateToolToolProvider = CreateToolToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], CreateToolToolProvider);
let UpdateToolToolProvider = UpdateToolToolProvider_1 = class UpdateToolToolProvider {
    getTool() {
        return {
            id: UpdateToolToolProvider_1.ID,
            name: UpdateToolToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Update an existing user-defined tool. Provide the tool id (from cc_listTools) '
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
                var _a;
                const { id } = parseArgs(args);
                return { label: `Update tool ${(_a = asString(id)) !== null && _a !== void 0 ? _a : '?'}`, hasMore: false };
            },
            handler: async (argString) => {
                var _a, _b, _c, _d;
                const args = parseArgs(argString);
                const id = asString(args.id);
                if (!id)
                    return 'Error: id is required.';
                const patch = {};
                for (const key of ['name', 'description', 'kind', 'integrationId', 'method', 'path', 'runtime', 'code', 'responseDescription', 'category']) {
                    const v = asString(args[key]);
                    if (v !== undefined)
                        patch[key] = v;
                }
                if (args.params !== undefined)
                    patch.params = normalizeToolParams(args.params);
                if (args.files !== undefined)
                    patch.files = (_a = asStringMap(args.files)) !== null && _a !== void 0 ? _a : {};
                if (args.requirements !== undefined)
                    patch.requirements = (_b = asStringArray(args.requirements)) !== null && _b !== void 0 ? _b : [];
                if (args.integrationRefs !== undefined)
                    patch.integrationRefs = (_c = asStringArray(args.integrationRefs)) !== null && _c !== void 0 ? _c : [];
                if (typeof args.timeoutMs === 'number')
                    patch.timeoutMs = args.timeoutMs;
                const sq = asStringMap(args.staticQueryParams);
                if (sq)
                    patch.staticQueryParams = sq;
                const sb = asStringMap(args.staticBody);
                if (sb)
                    patch.staticBody = sb;
                if (typeof args.enabled === 'boolean')
                    patch.enabled = args.enabled;
                try {
                    const tool = await this.configPlane.updateTool(id, patch);
                    const where = ((_d = tool.kind) !== null && _d !== void 0 ? _d : 'http') === 'script' ? `${tool.runtime} script` : `${tool.method} ${tool.path}`;
                    return `Tool updated.\nid: ${tool.id}\nname: ${tool.name}\n${where}`;
                }
                catch (err) {
                    return `Error updating tool: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.UpdateToolToolProvider = UpdateToolToolProvider;
UpdateToolToolProvider.ID = 'cc_updateTool';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], UpdateToolToolProvider.prototype, "configPlane", void 0);
exports.UpdateToolToolProvider = UpdateToolToolProvider = UpdateToolToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], UpdateToolToolProvider);
let DeleteToolToolProvider = DeleteToolToolProvider_1 = class DeleteToolToolProvider {
    getTool() {
        return {
            id: DeleteToolToolProvider_1.ID,
            name: DeleteToolToolProvider_1.ID,
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
                var _a;
                const { id } = parseArgs(args);
                return { label: `Delete tool ${(_a = asString(id)) !== null && _a !== void 0 ? _a : '?'}`, hasMore: false };
            },
            handler: async (argString) => {
                const args = parseArgs(argString);
                const id = asString(args.id);
                if (!id)
                    return 'Error: id is required.';
                try {
                    await this.configPlane.deleteTool(id);
                    return `Tool ${id} deleted.`;
                }
                catch (err) {
                    return `Error deleting tool: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.DeleteToolToolProvider = DeleteToolToolProvider;
DeleteToolToolProvider.ID = 'cc_deleteTool';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], DeleteToolToolProvider.prototype, "configPlane", void 0);
exports.DeleteToolToolProvider = DeleteToolToolProvider = DeleteToolToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], DeleteToolToolProvider);
let ExecuteToolToolProvider = ExecuteToolToolProvider_1 = class ExecuteToolToolProvider {
    getTool() {
        return {
            id: ExecuteToolToolProvider_1.ID,
            name: ExecuteToolToolProvider_1.ID,
            providerName: PROVIDER,
            description: 'Execute a user-defined tool by name or id. The runtime resolves the backing integration\'s '
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
                var _a;
                const { id } = parseArgs(args);
                return { label: `Execute tool ${(_a = asString(id)) !== null && _a !== void 0 ? _a : '?'}`, hasMore: false };
            },
            handler: async (argString) => {
                var _a;
                const args = parseArgs(argString);
                const id = asString(args.id);
                if (!id)
                    return 'Error: id is required.';
                let rawArgs = args.args;
                if (typeof rawArgs === 'string' && rawArgs.trim()) {
                    try {
                        rawArgs = JSON.parse(rawArgs);
                    }
                    catch { /* leave as-is */ }
                }
                const toolArgs = ((_a = asObject(rawArgs)) !== null && _a !== void 0 ? _a : {});
                try {
                    const result = await this.configPlane.executeTool(id, toolArgs);
                    if (result.error) {
                        return `Error: ${result.error}`;
                    }
                    const truncNote = result.truncated ? '\n[Response truncated to 32 KB]' : '';
                    return `HTTP ${result.status}\n${result.body}${truncNote}`;
                }
                catch (err) {
                    return `Error executing tool: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        };
    }
};
exports.ExecuteToolToolProvider = ExecuteToolToolProvider;
ExecuteToolToolProvider.ID = 'cc_executeTool';
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ExecuteToolToolProvider.prototype, "configPlane", void 0);
exports.ExecuteToolToolProvider = ExecuteToolToolProvider = ExecuteToolToolProvider_1 = __decorate([
    (0, inversify_1.injectable)()
], ExecuteToolToolProvider);
//# sourceMappingURL=agent-tools.js.map