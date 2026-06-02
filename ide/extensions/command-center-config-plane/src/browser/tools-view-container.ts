import { injectable } from '@theia/core/shared/inversify';
import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import {
    AbstractViewContribution,
    CommonMenus,
    FrontendApplication,
    FrontendApplicationContribution,
    codicon,
} from '@theia/core/lib/browser';

export const TOOLS_PANEL_ID = 'commandCenter.tools-panel';

export const OPEN_TOOLS_COMMAND = {
    id: 'commandCenter.tools.toggle',
    label: 'Command Center: Toggle Tools',
};

/**
 * Puts the Tools panel on the activity bar (left) so users can view, create,
 * edit, and delete user-defined integration tools from the sidebar.
 */
@injectable()
export class ToolsViewContribution
    extends AbstractViewContribution<import('@theia/core/lib/browser').Widget>
    implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: TOOLS_PANEL_ID,
            widgetName: 'Tools',
            defaultWidgetOptions: {
                area: 'left',
                rank: 600,
            },
            toggleCommandId: OPEN_TOOLS_COMMAND.id,
        });
    }

    async initializeLayout(_app: FrontendApplication): Promise<void> {
        // Do not force-open on startup; let the user open it explicitly.
    }

    override registerCommands(registry: CommandRegistry): void {
        super.registerCommands(registry);
        registry.registerCommand(OPEN_TOOLS_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true }),
        });
    }

    override registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
            commandId: OPEN_TOOLS_COMMAND.id,
            label: 'Tools',
        });
    }
}

/** Icon class for the Tools activity bar button. */
export const TOOLS_ICON = codicon('tools');
