import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { AgentsPanelWidget } from './agents-panel';
export declare const AGENTS_VIEW_CONTAINER_ID = "commandCenter.agents";
export declare const OPEN_AGENTS_COMMAND: {
    id: string;
    label: string;
};
export declare const AGENTS_VIEW_TITLE: {
    label: string;
    iconClass: string;
    closeable: boolean;
};
/**
 * Puts the Agents panel on the activity bar (left side) and opens it by
 * default.  The panel lists all agents, provides an LLM model selector, and
 * lets the user create, switch to, edit, or delete agents.
 */
export declare class AgentsViewContribution extends AbstractViewContribution<AgentsPanelWidget> implements FrontendApplicationContribution {
    constructor();
    initializeLayout(_app: FrontendApplication): Promise<void>;
    onStart(_app: FrontendApplication): Promise<void>;
    registerCommands(registry: CommandRegistry): void;
    registerMenus(menus: MenuModelRegistry): void;
}
