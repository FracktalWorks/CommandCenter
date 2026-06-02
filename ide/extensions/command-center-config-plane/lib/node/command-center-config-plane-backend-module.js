"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const node_1 = require("@theia/core/lib/node");
const config_plane_protocol_1 = require("../common/config-plane-protocol");
const config_plane_service_1 = require("./config-plane-service");
const oauth_callback_contribution_1 = require("./oauth-callback-contribution");
exports.default = new inversify_1.ContainerModule(bind => {
    bind(config_plane_service_1.ConfigPlaneServiceImpl).toSelf().inSingletonScope();
    bind(config_plane_protocol_1.ConfigPlaneService).toService(config_plane_service_1.ConfigPlaneServiceImpl);
    bind(oauth_callback_contribution_1.OAuthCallbackContribution).toSelf().inSingletonScope();
    bind(node_1.BackendApplicationContribution).toService(oauth_callback_contribution_1.OAuthCallbackContribution);
    bind(common_1.ConnectionHandler).toDynamicValue(ctx => new common_1.RpcConnectionHandler(config_plane_protocol_1.CONFIG_PLANE_SERVICE_PATH, () => ctx.container.get(config_plane_protocol_1.ConfigPlaneService))).inSingletonScope();
});
//# sourceMappingURL=command-center-config-plane-backend-module.js.map