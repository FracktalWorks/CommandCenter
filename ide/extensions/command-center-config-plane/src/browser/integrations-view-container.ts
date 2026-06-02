import { injectable } from '@theia/core/shared/inversify';
import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import {
    AbstractViewContribution,
    CommonMenus,
    FrontendApplication,
    FrontendApplicationContribution,
    ViewContainer,
    ViewContainerTitleOptions,
    codicon
} from '@theia/core/lib/browser';

export const INTEGRATIONS_VIEW_CONTAINER_ID = 'commandCenter.integrations';
export const INTEGRATIONS_VIEW_CONTAINER_TITLE: ViewContainerTitleOptions = {
    label: 'Integrations',
    iconClass: codicon('plug'),
    closeable: true
};

export const OPEN_INTEGRATIONS_COMMAND = {
    id: 'commandCenter.integrations.toggle',
    label: 'Command Center: Toggle Integrations'
};

/**
 * Puts the Integrations side bar on the activity bar (left) and opens it by
 * default. The container hosts one collapsible view per integration group:
 * LLMs, MCP Servers, APIs and Infrastructure & Other.
 */
@injectable()
export class IntegrationsViewContribution
    extends AbstractViewContribution<ViewContainer>
    implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: INTEGRATIONS_VIEW_CONTAINER_ID,
            widgetName: INTEGRATIONS_VIEW_CONTAINER_TITLE.label,
            defaultWidgetOptions: {
                area: 'left',
                rank: 500
            },
            toggleCommandId: OPEN_INTEGRATIONS_COMMAND.id
        });
    }

    /** Open the Integrations side bar by default so it is the active left view on boot. */
    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ activate: true, reveal: true });
    }

    override registerCommands(registry: CommandRegistry): void {
        super.registerCommands(registry);
        registry.registerCommand(OPEN_INTEGRATIONS_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }

    override registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
            commandId: OPEN_INTEGRATIONS_COMMAND.id,
            label: INTEGRATIONS_VIEW_CONTAINER_TITLE.label
        });
    }
}
