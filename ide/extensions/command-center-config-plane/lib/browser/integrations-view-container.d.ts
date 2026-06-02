import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution, ViewContainer, ViewContainerTitleOptions } from '@theia/core/lib/browser';
export declare const INTEGRATIONS_VIEW_CONTAINER_ID = "commandCenter.integrations";
export declare const INTEGRATIONS_VIEW_CONTAINER_TITLE: ViewContainerTitleOptions;
export declare const OPEN_INTEGRATIONS_COMMAND: {
    id: string;
    label: string;
};
/**
 * Puts the Integrations side bar on the activity bar (left) and opens it by
 * default. The container hosts one collapsible view per integration group:
 * LLMs, MCP Servers, APIs and Infrastructure & Other.
 */
export declare class IntegrationsViewContribution extends AbstractViewContribution<ViewContainer> implements FrontendApplicationContribution {
    constructor();
    /** Open the Integrations side bar by default so it is the active left view on boot. */
    initializeLayout(_app: FrontendApplication): Promise<void>;
    registerCommands(registry: CommandRegistry): void;
    registerMenus(menus: MenuModelRegistry): void;
}
