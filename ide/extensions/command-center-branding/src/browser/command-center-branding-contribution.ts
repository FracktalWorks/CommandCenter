import { injectable, inject } from '@theia/core/shared/inversify';
import {
    CommandContribution,
    CommandRegistry,
    MenuContribution,
    MenuModelRegistry,
    MessageService
} from '@theia/core/lib/common';
import { CommonMenus } from '@theia/core/lib/browser';

export const JannetAboutCommand = {
    id: 'commandCenter.about',
    label: 'Command Center: About'
};

@injectable()
export class JannetBrandingCommandContribution implements CommandContribution {

    constructor(
        @inject(MessageService) private readonly messageService: MessageService
    ) { }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(JannetAboutCommand, {
            execute: () => this.messageService.info(
                'Command Center — a self-hosted, browser-based multi-agent platform built on Eclipse Theia. Jannet and other agents, skills, and workflows build on top.'
            )
        });
    }
}

@injectable()
export class JannetBrandingMenuContribution implements MenuContribution {

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.HELP, {
            commandId: JannetAboutCommand.id,
            label: 'About Command Center'
        });
    }
}
