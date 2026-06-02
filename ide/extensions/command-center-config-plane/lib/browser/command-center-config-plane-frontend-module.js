"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const service_connection_provider_1 = require("@theia/core/lib/browser/messaging/service-connection-provider");
const tool_invocation_registry_1 = require("@theia/ai-core/lib/common/tool-invocation-registry");
const chat_input_widget_1 = require("@theia/ai-chat-ui/lib/browser/chat-input-widget");
const config_plane_protocol_1 = require("../common/config-plane-protocol");
const integrations_model_1 = require("./integrations-model");
const agents_model_1 = require("./agents-model");
const tools_model_1 = require("./tools-model");
const agents_panel_1 = require("./agents-panel");
const agents_view_container_1 = require("./agents-view-container");
const command_center_chat_input_widget_1 = require("./command-center-chat-input-widget");
const workspace_sessions_panel_1 = require("./workspace-sessions-panel");
const workspace_sessions_view_container_1 = require("./workspace-sessions-view-container");
const tools_panel_1 = require("./tools-panel");
const tools_view_container_1 = require("./tools-view-container");
const agent_tools_1 = require("./agent-tools");
const integration_widgets_1 = require("./integration-widgets");
const integrations_view_container_1 = require("./integrations-view-container");
/** Child views, in display order within the side bar. */
const CHILD_WIDGETS = [
    integration_widgets_1.LlmsWidget,
    integration_widgets_1.McpServersWidget,
    integration_widgets_1.ApisWidget,
    integration_widgets_1.WebhooksWidget,
    integration_widgets_1.OtherIntegrationsWidget
];
exports.default = new inversify_1.ContainerModule((bind, _unbind, isBound, rebind) => {
    // Backend proxy + shared models.
    bind(config_plane_protocol_1.ConfigPlaneService).toDynamicValue(ctx => {
        const provider = ctx.container.get(service_connection_provider_1.RemoteConnectionProvider);
        return provider.createProxy(config_plane_protocol_1.CONFIG_PLANE_SERVICE_PATH);
    }).inSingletonScope();
    bind(integrations_model_1.IntegrationsModel).toSelf().inSingletonScope();
    bind(agents_model_1.AgentsModel).toSelf().inSingletonScope();
    bind(workspace_sessions_panel_1.WorkspaceSessionsModel).toSelf().inSingletonScope();
    bind(tools_model_1.ToolsModel).toSelf().inSingletonScope();
    // Replace Theia's chat input with the Command Center variant that surfaces a model
    // picker and an on-the-fly agent picker inside the chat input box.
    if (isBound(chat_input_widget_1.AIChatInputWidget)) {
        rebind(chat_input_widget_1.AIChatInputWidget).to(command_center_chat_input_widget_1.CommandCenterChatInputWidget).inTransientScope();
    }
    else {
        bind(chat_input_widget_1.AIChatInputWidget).to(command_center_chat_input_widget_1.CommandCenterChatInputWidget).inTransientScope();
    }
    // Agent tools (terminal, web fetch, open link, file I/O) — give every chat
    // agent Copilot/Claude-Code-style capabilities via the ToolInvocationRegistry.
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.RunTerminalCommandToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.FetchWebpageToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.OpenLinkToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ReadFileToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.WriteFileToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ListFilesToolProvider, bind);
    // Integration management tools — let agents help configure, store and test
    // integrations (MCP servers, APIs, webhooks, infra) directly from chat.
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ListIntegrationKindsToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ListIntegrationsToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.CreateIntegrationToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.UpdateIntegrationToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.TestIntegrationToolProvider, bind);
    // OAuth 2.0 flow tools — let agents drive user-delegated (authorization-code)
    // and machine-to-machine (client-credentials) token acquisition + refresh.
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.StartOAuthToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.CompleteOAuthToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.RefreshOAuthToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.CallIntegrationToolProvider, bind);
    // User-defined Tool management tools — let agents create, list, update,
    // delete and execute named tool wrappers around integration endpoints.
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ListToolsToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.SearchToolsToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.CreateToolToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.UpdateToolToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.DeleteToolToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ExecuteToolToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ListSkillsToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.UseSkillToolProvider, bind);
    // Reflector tools: read agent feedback and propose directive improvements.
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ReadAgentFeedbackToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ProposeDirectiveToolProvider, bind);
    // Self-annealing tools — let agents inspect, create, edit and delete agents
    // (including themselves and each other), manage standing directives, and
    // author/remove reusable skills directly from the chat. This makes the AI
    // chat a full secondary interface for configuring the whole system.
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ListAgentsToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.GetAgentToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.CreateAgentToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.UpdateAgentToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.DeleteAgentToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.AddDirectiveToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.ManageDirectiveToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.WriteSkillToolProvider, bind);
    (0, tool_invocation_registry_1.bindToolProvider)(agent_tools_1.DeleteSkillToolProvider, bind);
    // One widget + factory per integration group.
    for (const Widget of CHILD_WIDGETS) {
        bind(Widget).toSelf();
        bind(browser_1.WidgetFactory).toDynamicValue(ctx => ({
            id: Widget.ID,
            createWidget: () => ctx.container.get(Widget)
        })).inSingletonScope();
    }
    // The Integrations view container (activity-bar entry + side bar).
    bind(browser_1.WidgetFactory).toDynamicValue(ctx => ({
        id: integrations_view_container_1.INTEGRATIONS_VIEW_CONTAINER_ID,
        createWidget: async () => {
            const viewContainer = ctx.container.get(browser_1.ViewContainer.Factory)({
                id: integrations_view_container_1.INTEGRATIONS_VIEW_CONTAINER_ID,
                progressLocationId: 'integrations'
            });
            viewContainer.setTitleOptions(integrations_view_container_1.INTEGRATIONS_VIEW_CONTAINER_TITLE);
            const manager = ctx.container.get(browser_1.WidgetManager);
            for (const Widget of CHILD_WIDGETS) {
                const child = await manager.getOrCreateWidget(Widget.ID);
                viewContainer.addWidget(child, { canHide: true, initiallyCollapsed: false });
            }
            return viewContainer;
        }
    })).inSingletonScope();
    // Activity-bar contribution for Integrations.
    (0, browser_1.bindViewContribution)(bind, integrations_view_container_1.IntegrationsViewContribution);
    bind(browser_1.FrontendApplicationContribution).toService(integrations_view_container_1.IntegrationsViewContribution);
    // Agents panel widget.
    bind(agents_panel_1.AgentsPanelWidget).toSelf();
    bind(browser_1.WidgetFactory).toDynamicValue(ctx => ({
        id: agents_panel_1.AgentsPanelWidget.ID,
        createWidget: () => ctx.container.get(agents_panel_1.AgentsPanelWidget),
    })).inSingletonScope();
    // Activity-bar contribution for Agents.
    (0, browser_1.bindViewContribution)(bind, agents_view_container_1.AgentsViewContribution);
    bind(browser_1.FrontendApplicationContribution).toService(agents_view_container_1.AgentsViewContribution);
    // Workspace sessions panel.
    bind(workspace_sessions_panel_1.WorkspaceSessionsPanel).toSelf();
    bind(browser_1.WidgetFactory).toDynamicValue(ctx => ({
        id: workspace_sessions_panel_1.WorkspaceSessionsPanel.ID,
        createWidget: () => ctx.container.get(workspace_sessions_panel_1.WorkspaceSessionsPanel),
    })).inSingletonScope();
    // Activity-bar contribution for Workspaces.
    (0, browser_1.bindViewContribution)(bind, workspace_sessions_view_container_1.WorkspaceSessionsViewContribution);
    bind(browser_1.FrontendApplicationContribution).toService(workspace_sessions_view_container_1.WorkspaceSessionsViewContribution);
    // Tools panel widget.
    bind(tools_panel_1.ToolsPanelWidget).toSelf();
    bind(browser_1.WidgetFactory).toDynamicValue(ctx => ({
        id: tools_panel_1.ToolsPanelWidget.ID,
        createWidget: () => ctx.container.get(tools_panel_1.ToolsPanelWidget),
    })).inSingletonScope();
    // Activity-bar contribution for Tools.
    (0, browser_1.bindViewContribution)(bind, tools_view_container_1.ToolsViewContribution);
    bind(browser_1.FrontendApplicationContribution).toService(tools_view_container_1.ToolsViewContribution);
});
//# sourceMappingURL=command-center-config-plane-frontend-module.js.map