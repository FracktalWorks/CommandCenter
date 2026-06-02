import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import {
    AbstractViewContribution,
    CommonMenus,
    FrontendApplication,
    FrontendApplicationContribution,
    codicon
} from '@theia/core/lib/browser';
import { ConfigPlaneService } from '../common/config-plane-protocol';
import { WorkspaceSessionsPanel } from './workspace-sessions-panel';

export const WORKSPACE_SESSIONS_VIEW_CONTAINER_ID = 'commandCenter.workspace-sessions';

export const OPEN_WORKSPACE_SESSIONS_COMMAND = {
    id: 'commandCenter.workspace-sessions.toggle',
    label: 'Command Center: Toggle Workspaces',
};

export const WORKSPACE_SESSIONS_VIEW_TITLE = {
    label: 'Workspaces',
    iconClass: codicon('folder-library'),
    closeable: true,
};

/**
 * Activity-bar view for Command Center workspace sessions.
 * Shows the scratch workspace, named sessions, and lets the user create new ones.
 */
@injectable()
export class WorkspaceSessionsViewContribution
    extends AbstractViewContribution<WorkspaceSessionsPanel>
    implements FrontendApplicationContribution {

    @inject(ConfigPlaneService)
    protected readonly service: ConfigPlaneService;

    constructor() {
        super({
            widgetId: WorkspaceSessionsPanel.ID,
            widgetName: WorkspaceSessionsPanel.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                rank: 492,
            },
            toggleCommandId: OPEN_WORKSPACE_SESSIONS_COMMAND.id,
        });
    }

    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ activate: false, reveal: false });
    }

    async onStart(_app: FrontendApplication): Promise<void> {
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
    protected async ensureScratchWorkspace(): Promise<void> {
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
        } catch {
            /* non-fatal: leave the IDE without a workspace */
        }
    }

    override registerCommands(registry: CommandRegistry): void {
        super.registerCommands(registry);
        registry.registerCommand(OPEN_WORKSPACE_SESSIONS_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true }),
        });
    }

    override registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
            commandId: OPEN_WORKSPACE_SESSIONS_COMMAND.id,
            label: WORKSPACE_SESSIONS_VIEW_TITLE.label,
        });
    }
}
