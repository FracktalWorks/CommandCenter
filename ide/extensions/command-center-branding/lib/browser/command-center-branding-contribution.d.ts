import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MessageService } from '@theia/core/lib/common';
export declare const JannetAboutCommand: {
    id: string;
    label: string;
};
export declare class JannetBrandingCommandContribution implements CommandContribution {
    private readonly messageService;
    constructor(messageService: MessageService);
    registerCommands(registry: CommandRegistry): void;
}
export declare class JannetBrandingMenuContribution implements MenuContribution {
    registerMenus(menus: MenuModelRegistry): void;
}
