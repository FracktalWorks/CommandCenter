import { injectable } from '@theia/core/shared/inversify';
import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import {
    AbstractViewContribution,
    CommonMenus,
    FrontendApplication,
    FrontendApplicationContribution,
    codicon
} from '@theia/core/lib/browser';
import { AgentsPanelWidget } from './agents-panel';

export const AGENTS_VIEW_CONTAINER_ID = 'commandCenter.agents';

export const OPEN_AGENTS_COMMAND = {
    id: 'commandCenter.agents.toggle',
    label: 'Command Center: Toggle Agents'
};

export const AGENTS_VIEW_TITLE = {
    label: 'Agents',
    iconClass: codicon('robot'),
    closeable: true,
};

/**
 * Puts the Agents panel on the activity bar (left side) and opens it by
 * default.  The panel lists all agents, provides an LLM model selector, and
 * lets the user create, switch to, edit, or delete agents.
 */
@injectable()
export class AgentsViewContribution
    extends AbstractViewContribution<AgentsPanelWidget>
    implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: AgentsPanelWidget.ID,
            widgetName: AgentsPanelWidget.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                rank: 490,
            },
            toggleCommandId: OPEN_AGENTS_COMMAND.id,
        });
    }

    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ activate: false, reveal: false });
    }

    async onStart(_app: FrontendApplication): Promise<void> {
        // Ensure the panel is always in the activity bar, even when the layout
        // is restored from a previous session (which skips initializeLayout).
        await this.openView({ activate: false, reveal: false });
    }

    override registerCommands(registry: CommandRegistry): void {
        super.registerCommands(registry);
        registry.registerCommand(OPEN_AGENTS_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }

    override registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
            commandId: OPEN_AGENTS_COMMAND.id,
            label: AGENTS_VIEW_TITLE.label,
        });
    }
}
