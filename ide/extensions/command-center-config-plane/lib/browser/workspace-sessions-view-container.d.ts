import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ConfigPlaneService } from '../common/config-plane-protocol';
import { WorkspaceSessionsPanel } from './workspace-sessions-panel';
export declare const WORKSPACE_SESSIONS_VIEW_CONTAINER_ID = "commandCenter.workspace-sessions";
export declare const OPEN_WORKSPACE_SESSIONS_COMMAND: {
    id: string;
    label: string;
};
export declare const WORKSPACE_SESSIONS_VIEW_TITLE: {
    label: string;
    iconClass: string;
    closeable: boolean;
};
/**
 * Activity-bar view for Command Center workspace sessions.
 * Shows the scratch workspace, named sessions, and lets the user create new ones.
 */
export declare class WorkspaceSessionsViewContribution extends AbstractViewContribution<WorkspaceSessionsPanel> implements FrontendApplicationContribution {
    protected readonly service: ConfigPlaneService;
    constructor();
    initializeLayout(_app: FrontendApplication): Promise<void>;
    onStart(_app: FrontendApplication): Promise<void>;
    /**
     * If the current browser URL has no `?folder=` param, navigate to the
     * scratch workspace once.  Guards against redirect loops by only acting
     * when no folder param is present.
     *
     * Uses `getDefaultWorkspacePath()` directly — this is faster and more
     * reliable than `listSessions()` because the backend creates the directory
     * synchronously in @postConstruct before any RPC call can arrive.
     */
    protected ensureScratchWorkspace(): Promise<void>;
    registerCommands(registry: CommandRegistry): void;
    registerMenus(menus: MenuModelRegistry): void;
}
