import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
export declare const TOOLS_PANEL_ID = "commandCenter.tools-panel";
export declare const OPEN_TOOLS_COMMAND: {
    id: string;
    label: string;
};
/**
 * Puts the Tools panel on the activity bar (left) so users can view, create,
 * edit, and delete user-defined integration tools from the sidebar.
 */
export declare class ToolsViewContribution extends AbstractViewContribution<import('@theia/core/lib/browser').Widget> implements FrontendApplicationContribution {
    constructor();
    initializeLayout(_app: FrontendApplication): Promise<void>;
    registerCommands(registry: CommandRegistry): void;
    registerMenus(menus: MenuModelRegistry): void;
}
/** Icon class for the Tools activity bar button. */
export declare const TOOLS_ICON: string;
