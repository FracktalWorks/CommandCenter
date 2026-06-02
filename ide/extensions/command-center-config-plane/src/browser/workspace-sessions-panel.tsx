// *****************************************************************************
// Workspace Sessions Panel
//
// Lists all workspace sessions from ~/.theia/sessions/ and lets the user:
//   - Open a session (navigates the browser to ?folder=<path>)
//   - Create a new named or ephemeral session
//   - Delete an existing session (scratch is protected)
//
// The panel also explains the three session modes so the user knows what each
// option means.
// *****************************************************************************

import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ConfigPlaneService, WorkspaceSession } from '../common/config-plane-protocol';

export const WORKSPACE_SESSIONS_PANEL_ID = 'commandCenter.workspace-sessions-panel';
export const WORKSPACE_SESSIONS_PANEL_LABEL = 'Workspaces';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
    padding: '10px 12px',
    overflow: 'auto',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
};

const sectionTitleStyle: React.CSSProperties = {
    fontSize: '0.78em',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    opacity: 0.6,
    margin: '12px 0 6px',
};

const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '4px 6px',
    background: 'var(--theia-input-background)',
    color: 'var(--theia-input-foreground)',
    border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
    borderRadius: '4px',
    fontSize: '0.9em',
    marginBottom: '6px',
};

const btnStyle = (variant: 'primary' | 'ghost' | 'danger'): React.CSSProperties => ({
    padding: '3px 10px',
    fontSize: '0.82em',
    cursor: 'pointer',
    borderRadius: '4px',
    border: '1px solid',
    borderColor:
        variant === 'primary' ? 'var(--theia-button-border, var(--theia-focusBorder))' :
        variant === 'danger'  ? 'var(--theia-inputValidation-errorBorder)' :
                                'var(--theia-editorWidget-border)',
    background:
        variant === 'primary' ? 'var(--theia-button-background)' :
        variant === 'danger'  ? 'transparent' :
                                'transparent',
    color:
        variant === 'primary' ? 'var(--theia-button-foreground)' :
        variant === 'danger'  ? 'var(--theia-inputValidation-errorForeground, #f48771)' :
                                'var(--theia-foreground)',
});

const tagStyle = (mode: string): React.CSSProperties => ({
    fontSize: '0.72em',
    padding: '1px 5px',
    borderRadius: '3px',
    border: '1px solid var(--theia-editorWidget-border)',
    opacity: 0.65,
    marginLeft: '6px',
    flexShrink: 0,
    whiteSpace: 'nowrap',
    background: mode === 'scratch' ? 'var(--theia-button-background, #0e639c)' : 'transparent',
    color: mode === 'scratch' ? 'var(--theia-button-foreground, #fff)' : 'inherit',
});

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface SessionRowProps {
    session: WorkspaceSession;
    isActive: boolean;
    onOpen: () => void;
    onDelete: () => void;
}

const SessionRow: React.FC<SessionRowProps> = ({ session, isActive, onOpen, onDelete }) => (
    <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '8px 10px',
        borderRadius: '6px',
        marginBottom: '2px',
        background: isActive
            ? 'var(--theia-list-activeSelectionBackground)'
            : 'var(--theia-sideBar-background, transparent)',
        cursor: 'pointer',
    }}>
        <div style={{ flex: 1, minWidth: 0 }} onClick={onOpen}>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontWeight: isActive ? 600 : 400,
                fontSize: '0.9em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
            }}>
                {session.name}
                <span style={tagStyle(session.mode)}>{session.mode}</span>
                {session.ephemeral && <span style={tagStyle('ephemeral')}>temp</span>}
            </div>
            <div style={{
                fontSize: '0.75em',
                opacity: 0.55,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: '1px',
            }}>
                {session.path}
            </div>
        </div>
        <div style={{ display: 'flex', gap: '4px', flexShrink: 0, marginTop: '2px' }}>
            <button style={btnStyle('primary')} onClick={e => { e.stopPropagation(); onOpen(); }}>
                Open
            </button>
            {session.mode !== 'scratch' && (
                <button
                    style={btnStyle('danger')}
                    title="Delete this workspace session"
                    onClick={e => { e.stopPropagation(); onDelete(); }}
                >
                    ✕
                </button>
            )}
        </div>
    </div>
);

// ---------------------------------------------------------------------------
// New session form
// ---------------------------------------------------------------------------

interface NewSessionFormProps {
    onCancel: () => void;
    onConfirm: (name: string, ephemeral: boolean) => Promise<void>;
}

const NewSessionForm: React.FC<NewSessionFormProps> = ({ onCancel, onConfirm }) => {
    const [name, setName] = React.useState('');
    const [ephemeral, setEphemeral] = React.useState(false);
    const [saving, setSaving] = React.useState(false);

    const handleSubmit = async () => {
        const trimmed = name.trim();
        if (!trimmed) { return; }
        setSaving(true);
        try {
            await onConfirm(trimmed, ephemeral);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div style={{
            padding: '8px 10px',
            border: '1px solid var(--theia-editorWidget-border)',
            borderRadius: '6px',
            marginBottom: '8px',
        }}>
            <div style={{ fontSize: '0.82em', opacity: 0.7, marginBottom: '6px' }}>New workspace session</div>
            <input
                style={inputStyle}
                placeholder="Session name…"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                autoFocus
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82em', marginBottom: '8px', cursor: 'pointer' }}>
                <input type="checkbox" checked={ephemeral} onChange={e => setEphemeral(e.target.checked)} />
                Temporary (can be deleted automatically)
            </label>
            <div style={{ display: 'flex', gap: '6px' }}>
                <button style={btnStyle('primary')} onClick={handleSubmit} disabled={saving || !name.trim()}>
                    {saving ? 'Creating…' : 'Create & Open'}
                </button>
                <button style={btnStyle('ghost')} onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Main model
// ---------------------------------------------------------------------------

@injectable()
export class WorkspaceSessionsModel {
    @inject(ConfigPlaneService)
    protected readonly service: ConfigPlaneService;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    sessions: WorkspaceSession[] = [];
    loading = false;
    error?: string;

    @postConstruct()
    protected init(): void {
        this.refresh();
    }

    refresh = async (): Promise<void> => {
        this.loading = true;
        this.error = undefined;
        this.onDidChangeEmitter.fire();
        try {
            this.sessions = await this.service.listSessions();
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
        } finally {
            this.loading = false;
            this.onDidChangeEmitter.fire();
        }
    };

    createSession = async (name: string, ephemeral: boolean): Promise<WorkspaceSession> => {
        const session = await this.service.createSession(name, ephemeral);
        await this.refresh();
        return session;
    };

    deleteSession = async (id: string): Promise<void> => {
        await this.service.deleteSession(id);
        await this.refresh();
    };
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

@injectable()
export class WorkspaceSessionsPanel extends ReactWidget {

    static readonly ID = WORKSPACE_SESSIONS_PANEL_ID;
    static readonly LABEL = WORKSPACE_SESSIONS_PANEL_LABEL;

    @inject(WorkspaceSessionsModel)
    protected readonly model: WorkspaceSessionsModel;

    @postConstruct()
    protected init(): void {
        this.id = WORKSPACE_SESSIONS_PANEL_ID;
        this.title.label = WORKSPACE_SESSIONS_PANEL_LABEL;
        this.title.closable = false;
        this.node.tabIndex = 0;
        this.model.onDidChange(() => this.update());
        this.update();
    }

    /**
     * Convert a native filesystem path to a `file://` URI that Theia's
     * WorkspaceService can parse via `new URI(folder)`.  On Windows, back-
     * slashes are normalised to forward-slashes and the drive letter gets
     * the required leading slash: `C:/foo` → `file:///C:/foo`.
     */
    protected toFileUri(nativePath: string): string {
        const forward = nativePath.replace(/\\/g, '/');
        return forward.startsWith('/') ? `file://${forward}` : `file:///${forward}`;
    }

    /**
     * Return the decoded `?folder=` URI from the current URL, or undefined.
     * Used to highlight the active session row.
     */
    protected get activeFolder(): string | undefined {
        if (typeof window === 'undefined') { return undefined; }
        const params = new URLSearchParams(window.location.search);
        const raw = params.get('folder');
        return raw ? decodeURIComponent(raw) : undefined;
    }

    /** Open a session by navigating to ?folder=<file-uri>. */
    protected openSession(session: WorkspaceSession): void {
        const uri = this.toFileUri(session.path);
        window.location.href = `/?folder=${encodeURIComponent(uri)}`;
    }

    protected showNewForm = false;

    protected render(): React.ReactNode {
        const { sessions, loading, error } = this.model;
        const active = this.activeFolder;

        // Active comparison is URI-based (both sides are file:// URIs after redirect).
        const activeUri = active;

        return (
            <div style={panelStyle}>
                <div style={sectionTitleStyle}>Workspaces</div>

                {/* Explainer */}
                <div style={{ fontSize: '0.8em', opacity: 0.6, marginBottom: '8px', lineHeight: 1.4 }}>
                    Each workspace is a directory agents operate in — where files are read/written and
                    shell commands run. Agents and skills always come from Command Center, not from here.
                </div>

                {/* Mode reference */}
                <div style={{ fontSize: '0.78em', opacity: 0.55, marginBottom: '10px', lineHeight: 1.5 }}>
                    <strong>scratch</strong> — default, always-available sandbox.<br />
                    <strong>named</strong> — your persistent project workspace.<br />
                    <strong>temp</strong> — ephemeral, can be cleaned up.
                </div>

                {loading && <div style={{ opacity: 0.55, fontSize: '0.85em' }}>Loading…</div>}
                {error && <div style={{ color: 'var(--theia-errorForeground)', fontSize: '0.82em', marginBottom: '6px' }}>{error}</div>}

                {/* Session list */}
                {sessions.map(s => (
                    <SessionRow
                        key={s.id}
                        session={s}
                        isActive={activeUri !== undefined && activeUri.endsWith(s.path.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, m => m.toLowerCase()))}
                        onOpen={() => this.openSession(s)}
                        onDelete={async () => {
                            try {
                                await this.model.deleteSession(s.id);
                            } catch (e) {
                                alert(e instanceof Error ? e.message : String(e));
                            }
                        }}
                    />
                ))}

                {/* New session form or button */}
                {this.showNewForm ? (
                    <NewSessionForm
                        onCancel={() => { this.showNewForm = false; this.update(); }}
                        onConfirm={async (name, ephemeral) => {
                            const session = await this.model.createSession(name, ephemeral);
                            this.showNewForm = false;
                            this.openSession(session);
                        }}
                    />
                ) : (
                    <button
                        style={{ ...btnStyle('ghost'), marginTop: '8px', width: '100%' }}
                        onClick={() => { this.showNewForm = true; this.update(); }}
                    >
                        + New Workspace Session
                    </button>
                )}

                {/* Refresh */}
                <button
                    style={{ ...btnStyle('ghost'), marginTop: '4px', width: '100%', opacity: 0.6 }}
                    onClick={() => this.model.refresh()}
                >
                    ↻ Refresh
                </button>
            </div>
        );
    }
}
