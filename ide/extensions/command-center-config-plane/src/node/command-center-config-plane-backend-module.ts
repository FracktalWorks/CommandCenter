import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { CONFIG_PLANE_SERVICE_PATH, ConfigPlaneService } from '../common/config-plane-protocol';
import { ConfigPlaneServiceImpl } from './config-plane-service';
import { OAuthCallbackContribution } from './oauth-callback-contribution';

export default new ContainerModule(bind => {
    bind(ConfigPlaneServiceImpl).toSelf().inSingletonScope();
    bind(ConfigPlaneService).toService(ConfigPlaneServiceImpl);

    bind(OAuthCallbackContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(OAuthCallbackContribution);

    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler(
            CONFIG_PLANE_SERVICE_PATH,
            () => ctx.container.get<ConfigPlaneService>(ConfigPlaneService)
        )
    ).inSingletonScope();
});
