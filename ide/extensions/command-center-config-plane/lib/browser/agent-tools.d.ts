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
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { ConfigPlaneService } from '../common/config-plane-protocol';
export declare class RunTerminalCommandToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class FetchWebpageToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class OpenLinkToolProvider implements ToolProvider {
    static ID: string;
    protected readonly windowService: WindowService;
    getTool(): ToolRequest;
}
export declare class ReadFileToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class WriteFileToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class ListFilesToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class ListIntegrationKindsToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class ListIntegrationsToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class CreateIntegrationToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class UpdateIntegrationToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class TestIntegrationToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class StartOAuthToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class CompleteOAuthToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class RefreshOAuthToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/**
 * Lists every skill available to agents (name, domain, description and
 * when-to-use), scanned from the repo skill folders and `~/.theia/skills`.
 */
export declare class ListSkillsToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/**
 * Loads the full instruction body of a single skill by name, so the agent can
 * follow its detailed steps (progressive disclosure).
 */
export declare class UseSkillToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/**
 * Loads the recent feedback log for an agent.
 * Used by the Reflector agent to analyse patterns and propose directives.
 */
export declare class ReadAgentFeedbackToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/**
 * Proposes a new standing directive for an agent.
 * Creates a 'pending' directive that appears in the Agents panel for review.
 */
export declare class ProposeDirectiveToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/**
 * Lists every agent with its core configuration (model, soul, skills,
 * directive summary). The entry point for self-annealing — call this first to
 * discover agent ids before inspecting or editing one.
 */
export declare class ListAgentsToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/** Returns one agent's complete definition, including its full system prompt. */
export declare class GetAgentToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/** Creates a new specialised agent from a name, description and system prompt. */
export declare class CreateAgentToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/** Edits an existing agent: prompt, model, soul, skills, visibility, name. */
export declare class UpdateAgentToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/** Permanently deletes a custom (non built-in) agent. */
export declare class DeleteAgentToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/**
 * Adds a standing directive to an agent. Unlike cc_proposeDirective (which
 * submits a *pending* Reflector proposal), this adds an immediately-active rule.
 */
export declare class AddDirectiveToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/** Approves, rejects, updates or removes an existing directive on an agent. */
export declare class ManageDirectiveToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/** Creates or overwrites a reusable skill (SKILL.md) authored from chat. */
export declare class WriteSkillToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/** Deletes a user-authored skill. */
export declare class DeleteSkillToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
/**
 * Makes an authenticated HTTP request to a configured `api` integration.
 * Auth headers (Bearer token, API key, Basic, or OAuth access token with
 * auto-refresh) are applied automatically from the stored credentials.
 * The response body is returned as a string for the agent to parse.
 */
export declare class CallIntegrationToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class ListToolsToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class SearchToolsToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class CreateToolToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class UpdateToolToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class DeleteToolToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
export declare class ExecuteToolToolProvider implements ToolProvider {
    static ID: string;
    protected readonly configPlane: ConfigPlaneService;
    getTool(): ToolRequest;
}
