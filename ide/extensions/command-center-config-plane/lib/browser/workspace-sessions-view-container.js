"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceSessionsViewContribution = exports.WORKSPACE_SESSIONS_VIEW_TITLE = exports.OPEN_WORKSPACE_SESSIONS_COMMAND = exports.WORKSPACE_SESSIONS_VIEW_CONTAINER_ID = void 0;
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const config_plane_protocol_1 = require("../common/config-plane-protocol");
const workspace_sessions_panel_1 = require("./workspace-sessions-panel");
exports.WORKSPACE_SESSIONS_VIEW_CONTAINER_ID = 'commandCenter.workspace-sessions';
exports.OPEN_WORKSPACE_SESSIONS_COMMAND = {
    id: 'commandCenter.workspace-sessions.toggle',
    label: 'Command Center: Toggle Workspaces',
};
exports.WORKSPACE_SESSIONS_VIEW_TITLE = {
    label: 'Workspaces',
    iconClass: (0, browser_1.codicon)('folder-library'),
    closeable: true,
};
/**
 * Activity-bar view for Command Center workspace sessions.
 * Shows the scratch workspace, named sessions, and lets the user create new ones.
 */
let WorkspaceSessionsViewContribution = class WorkspaceSessionsViewContribution extends browser_1.AbstractViewContribution {
    constructor() {
        super({
            widgetId: workspace_sessions_panel_1.WorkspaceSessionsPanel.ID,
            widgetName: workspace_sessions_panel_1.WorkspaceSessionsPanel.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                rank: 492,
            },
            toggleCommandId: exports.OPEN_WORKSPACE_SESSIONS_COMMAND.id,
        });
    }
    async initializeLayout(_app) {
        await this.openView({ activate: false, reveal: false });
    }
    async onStart(_app) {
        await this.openView({ activate: false, reveal: false });
        // When Command Center is opened with no workspace folder, fall back to
        // the scratch workspace so agents (shellExecute, file tools) have a
        // sane working directory instead of the IDE process cwd / '.'.
        await this.ensureScratchWorkspace();
    }
    /**
     * If the current browser URL has no `?folder=` param, navigate to the
     * scratch workspace once.  Guards against redirect loops by only acting
     * when no folder param is present.
     *
     * Uses `getDefaultWorkspacePath()` directly — this is faster and more
     * reliable than `listSessions()` because the backend creates the directory
     * synchronously in @postConstruct before any RPC call can arrive.
     */
    async ensureScratchWorkspace() {
        if (typeof window === 'undefined') {
            return;
        }
        const params = new URLSearchParams(window.location.search);
        if (params.get('folder')) {
            return;
        }
        try {
            const scratchPath = await this.service.getDefaultWorkspacePath();
            // Convert Windows path to a proper file:// URI so Theia's
            // WorkspaceService (which uses `new URI(folder)`) parses it
            // correctly.  Raw Windows paths like C:\... get misread as
            // scheme 'C' by the URI parser.
            const forward = scratchPath.replace(/\\/g, '/');
            const fileUri = forward.startsWith('/') ? `file://${forward}` : `file:///${forward}`;
            window.location.href = `/?folder=${encodeURIComponent(fileUri)}`;
        }
        catch {
            /* non-fatal: leave the IDE without a workspace */
        }
    }
    registerCommands(registry) {
        super.registerCommands(registry);
        registry.registerCommand(exports.OPEN_WORKSPACE_SESSIONS_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true }),
        });
    }
    registerMenus(menus) {
        super.registerMenus(menus);
        menus.registerMenuAction(browser_1.CommonMenus.VIEW_VIEWS, {
            commandId: exports.OPEN_WORKSPACE_SESSIONS_COMMAND.id,
            label: exports.WORKSPACE_SESSIONS_VIEW_TITLE.label,
        });
    }
};
exports.WorkspaceSessionsViewContribution = WorkspaceSessionsViewContribution;
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], WorkspaceSessionsViewContribution.prototype, "service", void 0);
exports.WorkspaceSessionsViewContribution = WorkspaceSessionsViewContribution = __decorate([
    (0, inversify_1.injectable)(),
    __metadata("design:paramtypes", [])
], WorkspaceSessionsViewContribution);
//# sourceMappingURL=workspace-sessions-view-container.js.map