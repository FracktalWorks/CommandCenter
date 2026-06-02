/// <reference types="react" />
import * as React from '@theia/core/shared/react';
import { Emitter, Event } from '@theia/core/lib/common';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ConfigPlaneService, WorkspaceSession } from '../common/config-plane-protocol';
export declare const WORKSPACE_SESSIONS_PANEL_ID = "commandCenter.workspace-sessions-panel";
export declare const WORKSPACE_SESSIONS_PANEL_LABEL = "Workspaces";
export declare class WorkspaceSessionsModel {
    protected readonly service: ConfigPlaneService;
    protected readonly onDidChangeEmitter: Emitter<void>;
    readonly onDidChange: Event<void>;
    sessions: WorkspaceSession[];
    loading: boolean;
    error?: string;
    protected init(): void;
    refresh: () => Promise<void>;
    createSession: (name: string, ephemeral: boolean) => Promise<WorkspaceSession>;
    deleteSession: (id: string) => Promise<void>;
}
export declare class WorkspaceSessionsPanel extends ReactWidget {
    static readonly ID = "commandCenter.workspace-sessions-panel";
    static readonly LABEL = "Workspaces";
    protected readonly model: WorkspaceSessionsModel;
    protected init(): void;
    /**
     * Convert a native filesystem path to a `file://` URI that Theia's
     * WorkspaceService can parse via `new URI(folder)`.  On Windows, back-
     * slashes are normalised to forward-slashes and the drive letter gets
     * the required leading slash: `C:/foo` → `file:///C:/foo`.
     */
    protected toFileUri(nativePath: string): string;
    /**
     * Return the decoded `?folder=` URI from the current URL, or undefined.
     * Used to highlight the active session row.
     */
    protected get activeFolder(): string | undefined;
    /** Open a session by navigating to ?folder=<file-uri>. */
    protected openSession(session: WorkspaceSession): void;
    protected showNewForm: boolean;
    protected render(): React.ReactNode;
}
