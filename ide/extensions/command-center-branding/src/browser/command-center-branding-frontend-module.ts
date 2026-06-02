import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { JannetBrandingCommandContribution, JannetBrandingMenuContribution } from './command-center-branding-contribution';

export default new ContainerModule(bind => {
    bind(CommandContribution).to(JannetBrandingCommandContribution);
    bind(MenuContribution).to(JannetBrandingMenuContribution);
});
