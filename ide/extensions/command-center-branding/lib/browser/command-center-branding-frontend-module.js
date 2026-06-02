"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const command_center_branding_contribution_1 = require("./command-center-branding-contribution");
exports.default = new inversify_1.ContainerModule(bind => {
    bind(common_1.CommandContribution).to(command_center_branding_contribution_1.JannetBrandingCommandContribution);
    bind(common_1.MenuContribution).to(command_center_branding_contribution_1.JannetBrandingMenuContribution);
});
//# sourceMappingURL=command-center-branding-frontend-module.js.map