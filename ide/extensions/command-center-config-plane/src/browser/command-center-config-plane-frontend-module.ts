import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import {
    FrontendApplicationContribution,
    ViewContainer,
    ViewContainerIdentifier,
    WidgetFactory,
    WidgetManager,
    bindViewContribution
} from '@theia/core/lib/browser';
import { RemoteConnectionProvider, ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { bindToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { AIChatInputWidget } from '@theia/ai-chat-ui/lib/browser/chat-input-widget';
import { CONFIG_PLANE_SERVICE_PATH, ConfigPlaneService } from '../common/config-plane-protocol';
import { IntegrationsModel } from './integrations-model';
import { AgentsModel } from './agents-model';
import { ToolsModel } from './tools-model';
import { AgentsPanelWidget } from './agents-panel';
import { AgentsViewContribution } from './agents-view-container';
import { CommandCenterChatInputWidget } from './command-center-chat-input-widget';
import {
    WorkspaceSessionsModel,
    WorkspaceSessionsPanel,
} from './workspace-sessions-panel';
import { WorkspaceSessionsViewContribution } from './workspace-sessions-view-container';
import { ToolsPanelWidget } from './tools-panel';
import { ToolsViewContribution } from './tools-view-container';
import {
    FetchWebpageToolProvider,
    ListFilesToolProvider,
    OpenLinkToolProvider,
    ReadFileToolProvider,
    RunTerminalCommandToolProvider,
    WriteFileToolProvider,
    ListIntegrationKindsToolProvider,
    ListIntegrationsToolProvider,
    CreateIntegrationToolProvider,
    UpdateIntegrationToolProvider,
    TestIntegrationToolProvider,
    StartOAuthToolProvider,
    CompleteOAuthToolProvider,
    RefreshOAuthToolProvider,
    CallIntegrationToolProvider,
    ListToolsToolProvider,
    SearchToolsToolProvider,
    CreateToolToolProvider,
    UpdateToolToolProvider,
    DeleteToolToolProvider,
    ExecuteToolToolProvider,
    ListSkillsToolProvider,
    UseSkillToolProvider,
    ReadAgentFeedbackToolProvider,
    ProposeDirectiveToolProvider,
    ListAgentsToolProvider,
    GetAgentToolProvider,
    CreateAgentToolProvider,
    UpdateAgentToolProvider,
    DeleteAgentToolProvider,
    AddDirectiveToolProvider,
    ManageDirectiveToolProvider,
    WriteSkillToolProvider,
    DeleteSkillToolProvider,
} from './agent-tools';
import {
    ApisWidget,
    IntegrationSectionWidget,
    LlmsWidget,
    McpServersWidget,
    OtherIntegrationsWidget,
    WebhooksWidget
} from './integration-widgets';
import {
    INTEGRATIONS_VIEW_CONTAINER_ID,
    INTEGRATIONS_VIEW_CONTAINER_TITLE,
    IntegrationsViewContribution
} from './integrations-view-container';

/** Child views, in display order within the side bar. */
const CHILD_WIDGETS: Array<interfaces.Newable<IntegrationSectionWidget> & { ID: string }> = [
    LlmsWidget,
    McpServersWidget,
    ApisWidget,
    WebhooksWidget,
    OtherIntegrationsWidget
];

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
    // Backend proxy + shared models.
    bind(ConfigPlaneService).toDynamicValue(ctx => {
        const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<ConfigPlaneService>(CONFIG_PLANE_SERVICE_PATH);
    }).inSingletonScope();
    bind(IntegrationsModel).toSelf().inSingletonScope();
    bind(AgentsModel).toSelf().inSingletonScope();
    bind(WorkspaceSessionsModel).toSelf().inSingletonScope();
    bind(ToolsModel).toSelf().inSingletonScope();

    // Replace Theia's chat input with the Command Center variant that surfaces a model
    // picker and an on-the-fly agent picker inside the chat input box.
    if (isBound(AIChatInputWidget)) {
        rebind(AIChatInputWidget).to(CommandCenterChatInputWidget).inTransientScope();
    } else {
        bind(AIChatInputWidget).to(CommandCenterChatInputWidget).inTransientScope();
    }

    // Agent tools (terminal, web fetch, open link, file I/O) — give every chat
    // agent Copilot/Claude-Code-style capabilities via the ToolInvocationRegistry.
    bindToolProvider(RunTerminalCommandToolProvider, bind);
    bindToolProvider(FetchWebpageToolProvider, bind);
    bindToolProvider(OpenLinkToolProvider, bind);
    bindToolProvider(ReadFileToolProvider, bind);
    bindToolProvider(WriteFileToolProvider, bind);
    bindToolProvider(ListFilesToolProvider, bind);

    // Integration management tools — let agents help configure, store and test
    // integrations (MCP servers, APIs, webhooks, infra) directly from chat.
    bindToolProvider(ListIntegrationKindsToolProvider, bind);
    bindToolProvider(ListIntegrationsToolProvider, bind);
    bindToolProvider(CreateIntegrationToolProvider, bind);
    bindToolProvider(UpdateIntegrationToolProvider, bind);
    bindToolProvider(TestIntegrationToolProvider, bind);
    // OAuth 2.0 flow tools — let agents drive user-delegated (authorization-code)
    // and machine-to-machine (client-credentials) token acquisition + refresh.
    bindToolProvider(StartOAuthToolProvider, bind);
    bindToolProvider(CompleteOAuthToolProvider, bind);
    bindToolProvider(RefreshOAuthToolProvider, bind);
    bindToolProvider(CallIntegrationToolProvider, bind);
    // User-defined Tool management tools — let agents create, list, update,
    // delete and execute named tool wrappers around integration endpoints.
    bindToolProvider(ListToolsToolProvider, bind);
    bindToolProvider(SearchToolsToolProvider, bind);
    bindToolProvider(CreateToolToolProvider, bind);
    bindToolProvider(UpdateToolToolProvider, bind);
    bindToolProvider(DeleteToolToolProvider, bind);
    bindToolProvider(ExecuteToolToolProvider, bind);
    bindToolProvider(ListSkillsToolProvider, bind);
    bindToolProvider(UseSkillToolProvider, bind);
    // Reflector tools: read agent feedback and propose directive improvements.
    bindToolProvider(ReadAgentFeedbackToolProvider, bind);
    bindToolProvider(ProposeDirectiveToolProvider, bind);

    // Self-annealing tools — let agents inspect, create, edit and delete agents
    // (including themselves and each other), manage standing directives, and
    // author/remove reusable skills directly from the chat. This makes the AI
    // chat a full secondary interface for configuring the whole system.
    bindToolProvider(ListAgentsToolProvider, bind);
    bindToolProvider(GetAgentToolProvider, bind);
    bindToolProvider(CreateAgentToolProvider, bind);
    bindToolProvider(UpdateAgentToolProvider, bind);
    bindToolProvider(DeleteAgentToolProvider, bind);
    bindToolProvider(AddDirectiveToolProvider, bind);
    bindToolProvider(ManageDirectiveToolProvider, bind);
    bindToolProvider(WriteSkillToolProvider, bind);
    bindToolProvider(DeleteSkillToolProvider, bind);

    // One widget + factory per integration group.
    for (const Widget of CHILD_WIDGETS) {
        bind(Widget).toSelf();
        bind(WidgetFactory).toDynamicValue(ctx => ({
            id: Widget.ID,
            createWidget: () => ctx.container.get(Widget)
        })).inSingletonScope();
    }

    // The Integrations view container (activity-bar entry + side bar).
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: INTEGRATIONS_VIEW_CONTAINER_ID,
        createWidget: async () => {
            const viewContainer = ctx.container.get<ViewContainer.Factory>(ViewContainer.Factory)({
                id: INTEGRATIONS_VIEW_CONTAINER_ID,
                progressLocationId: 'integrations'
            } as ViewContainerIdentifier);
            viewContainer.setTitleOptions(INTEGRATIONS_VIEW_CONTAINER_TITLE);
            const manager = ctx.container.get(WidgetManager);
            for (const Widget of CHILD_WIDGETS) {
                const child = await manager.getOrCreateWidget(Widget.ID);
                viewContainer.addWidget(child, { canHide: true, initiallyCollapsed: false });
            }
            return viewContainer;
        }
    })).inSingletonScope();

    // Activity-bar contribution for Integrations.
    bindViewContribution(bind, IntegrationsViewContribution);
    bind(FrontendApplicationContribution).toService(IntegrationsViewContribution);

    // Agents panel widget.
    bind(AgentsPanelWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: AgentsPanelWidget.ID,
        createWidget: () => ctx.container.get(AgentsPanelWidget),
    })).inSingletonScope();

    // Activity-bar contribution for Agents.
    bindViewContribution(bind, AgentsViewContribution);
    bind(FrontendApplicationContribution).toService(AgentsViewContribution);

    // Workspace sessions panel.
    bind(WorkspaceSessionsPanel).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: WorkspaceSessionsPanel.ID,
        createWidget: () => ctx.container.get(WorkspaceSessionsPanel),
    })).inSingletonScope();

    // Activity-bar contribution for Workspaces.
    bindViewContribution(bind, WorkspaceSessionsViewContribution);
    bind(FrontendApplicationContribution).toService(WorkspaceSessionsViewContribution);

    // Tools panel widget.
    bind(ToolsPanelWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ToolsPanelWidget.ID,
        createWidget: () => ctx.container.get(ToolsPanelWidget),
    })).inSingletonScope();

    // Activity-bar contribution for Tools.
    bindViewContribution(bind, ToolsViewContribution);
    bind(FrontendApplicationContribution).toService(ToolsViewContribution);
});


