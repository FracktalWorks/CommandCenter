"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceSessionsPanel = exports.WorkspaceSessionsModel = exports.WORKSPACE_SESSIONS_PANEL_LABEL = exports.WORKSPACE_SESSIONS_PANEL_ID = void 0;
const React = __importStar(require("@theia/core/shared/react"));
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const react_widget_1 = require("@theia/core/lib/browser/widgets/react-widget");
const config_plane_protocol_1 = require("../common/config-plane-protocol");
exports.WORKSPACE_SESSIONS_PANEL_ID = 'commandCenter.workspace-sessions-panel';
exports.WORKSPACE_SESSIONS_PANEL_LABEL = 'Workspaces';
// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const panelStyle = {
    padding: '10px 12px',
    overflow: 'auto',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
};
const sectionTitleStyle = {
    fontSize: '0.78em',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    opacity: 0.6,
    margin: '12px 0 6px',
};
const inputStyle = {
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
const btnStyle = (variant) => ({
    padding: '3px 10px',
    fontSize: '0.82em',
    cursor: 'pointer',
    borderRadius: '4px',
    border: '1px solid',
    borderColor: variant === 'primary' ? 'var(--theia-button-border, var(--theia-focusBorder))' :
        variant === 'danger' ? 'var(--theia-inputValidation-errorBorder)' :
            'var(--theia-editorWidget-border)',
    background: variant === 'primary' ? 'var(--theia-button-background)' :
        variant === 'danger' ? 'transparent' :
            'transparent',
    color: variant === 'primary' ? 'var(--theia-button-foreground)' :
        variant === 'danger' ? 'var(--theia-inputValidation-errorForeground, #f48771)' :
            'var(--theia-foreground)',
});
const tagStyle = (mode) => ({
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
const SessionRow = ({ session, isActive, onOpen, onDelete }) => (React.createElement("div", { style: {
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
    } },
    React.createElement("div", { style: { flex: 1, minWidth: 0 }, onClick: onOpen },
        React.createElement("div", { style: {
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontWeight: isActive ? 600 : 400,
                fontSize: '0.9em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
            } },
            session.name,
            React.createElement("span", { style: tagStyle(session.mode) }, session.mode),
            session.ephemeral && React.createElement("span", { style: tagStyle('ephemeral') }, "temp")),
        React.createElement("div", { style: {
                fontSize: '0.75em',
                opacity: 0.55,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: '1px',
            } }, session.path)),
    React.createElement("div", { style: { display: 'flex', gap: '4px', flexShrink: 0, marginTop: '2px' } },
        React.createElement("button", { style: btnStyle('primary'), onClick: e => { e.stopPropagation(); onOpen(); } }, "Open"),
        session.mode !== 'scratch' && (React.createElement("button", { style: btnStyle('danger'), title: "Delete this workspace session", onClick: e => { e.stopPropagation(); onDelete(); } }, "\u2715")))));
const NewSessionForm = ({ onCancel, onConfirm }) => {
    const [name, setName] = React.useState('');
    const [ephemeral, setEphemeral] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const handleSubmit = async () => {
        const trimmed = name.trim();
        if (!trimmed) {
            return;
        }
        setSaving(true);
        try {
            await onConfirm(trimmed, ephemeral);
        }
        finally {
            setSaving(false);
        }
    };
    return (React.createElement("div", { style: {
            padding: '8px 10px',
            border: '1px solid var(--theia-editorWidget-border)',
            borderRadius: '6px',
            marginBottom: '8px',
        } },
        React.createElement("div", { style: { fontSize: '0.82em', opacity: 0.7, marginBottom: '6px' } }, "New workspace session"),
        React.createElement("input", { style: inputStyle, placeholder: "Session name\u2026", value: name, onChange: e => setName(e.target.value), onKeyDown: e => e.key === 'Enter' && handleSubmit(), autoFocus: true }),
        React.createElement("label", { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82em', marginBottom: '8px', cursor: 'pointer' } },
            React.createElement("input", { type: "checkbox", checked: ephemeral, onChange: e => setEphemeral(e.target.checked) }),
            "Temporary (can be deleted automatically)"),
        React.createElement("div", { style: { display: 'flex', gap: '6px' } },
            React.createElement("button", { style: btnStyle('primary'), onClick: handleSubmit, disabled: saving || !name.trim() }, saving ? 'Creating…' : 'Create & Open'),
            React.createElement("button", { style: btnStyle('ghost'), onClick: onCancel }, "Cancel"))));
};
// ---------------------------------------------------------------------------
// Main model
// ---------------------------------------------------------------------------
let WorkspaceSessionsModel = class WorkspaceSessionsModel {
    constructor() {
        this.onDidChangeEmitter = new common_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.sessions = [];
        this.loading = false;
        this.refresh = async () => {
            this.loading = true;
            this.error = undefined;
            this.onDidChangeEmitter.fire();
            try {
                this.sessions = await this.service.listSessions();
            }
            catch (e) {
                this.error = e instanceof Error ? e.message : String(e);
            }
            finally {
                this.loading = false;
                this.onDidChangeEmitter.fire();
            }
        };
        this.createSession = async (name, ephemeral) => {
            const session = await this.service.createSession(name, ephemeral);
            await this.refresh();
            return session;
        };
        this.deleteSession = async (id) => {
            await this.service.deleteSession(id);
            await this.refresh();
        };
    }
    init() {
        this.refresh();
    }
};
exports.WorkspaceSessionsModel = WorkspaceSessionsModel;
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], WorkspaceSessionsModel.prototype, "service", void 0);
__decorate([
    (0, inversify_1.postConstruct)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], WorkspaceSessionsModel.prototype, "init", null);
exports.WorkspaceSessionsModel = WorkspaceSessionsModel = __decorate([
    (0, inversify_1.injectable)()
], WorkspaceSessionsModel);
// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------
let WorkspaceSessionsPanel = class WorkspaceSessionsPanel extends react_widget_1.ReactWidget {
    constructor() {
        super(...arguments);
        this.showNewForm = false;
    }
    init() {
        this.id = exports.WORKSPACE_SESSIONS_PANEL_ID;
        this.title.label = exports.WORKSPACE_SESSIONS_PANEL_LABEL;
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
    toFileUri(nativePath) {
        const forward = nativePath.replace(/\\/g, '/');
        return forward.startsWith('/') ? `file://${forward}` : `file:///${forward}`;
    }
    /**
     * Return the decoded `?folder=` URI from the current URL, or undefined.
     * Used to highlight the active session row.
     */
    get activeFolder() {
        if (typeof window === 'undefined') {
            return undefined;
        }
        const params = new URLSearchParams(window.location.search);
        const raw = params.get('folder');
        return raw ? decodeURIComponent(raw) : undefined;
    }
    /** Open a session by navigating to ?folder=<file-uri>. */
    openSession(session) {
        const uri = this.toFileUri(session.path);
        window.location.href = `/?folder=${encodeURIComponent(uri)}`;
    }
    render() {
        const { sessions, loading, error } = this.model;
        const active = this.activeFolder;
        // Active comparison is URI-based (both sides are file:// URIs after redirect).
        const activeUri = active;
        return (React.createElement("div", { style: panelStyle },
            React.createElement("div", { style: sectionTitleStyle }, "Workspaces"),
            React.createElement("div", { style: { fontSize: '0.8em', opacity: 0.6, marginBottom: '8px', lineHeight: 1.4 } }, "Each workspace is a directory agents operate in \u2014 where files are read/written and shell commands run. Agents and skills always come from Command Center, not from here."),
            React.createElement("div", { style: { fontSize: '0.78em', opacity: 0.55, marginBottom: '10px', lineHeight: 1.5 } },
                React.createElement("strong", null, "scratch"),
                " \u2014 default, always-available sandbox.",
                React.createElement("br", null),
                React.createElement("strong", null, "named"),
                " \u2014 your persistent project workspace.",
                React.createElement("br", null),
                React.createElement("strong", null, "temp"),
                " \u2014 ephemeral, can be cleaned up."),
            loading && React.createElement("div", { style: { opacity: 0.55, fontSize: '0.85em' } }, "Loading\u2026"),
            error && React.createElement("div", { style: { color: 'var(--theia-errorForeground)', fontSize: '0.82em', marginBottom: '6px' } }, error),
            sessions.map(s => (React.createElement(SessionRow, { key: s.id, session: s, isActive: activeUri !== undefined && activeUri.endsWith(s.path.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, m => m.toLowerCase())), onOpen: () => this.openSession(s), onDelete: async () => {
                    try {
                        await this.model.deleteSession(s.id);
                    }
                    catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                    }
                } }))),
            this.showNewForm ? (React.createElement(NewSessionForm, { onCancel: () => { this.showNewForm = false; this.update(); }, onConfirm: async (name, ephemeral) => {
                    const session = await this.model.createSession(name, ephemeral);
                    this.showNewForm = false;
                    this.openSession(session);
                } })) : (React.createElement("button", { style: { ...btnStyle('ghost'), marginTop: '8px', width: '100%' }, onClick: () => { this.showNewForm = true; this.update(); } }, "+ New Workspace Session")),
            React.createElement("button", { style: { ...btnStyle('ghost'), marginTop: '4px', width: '100%', opacity: 0.6 }, onClick: () => this.model.refresh() }, "\u21BB Refresh")));
    }
};
exports.WorkspaceSessionsPanel = WorkspaceSessionsPanel;
WorkspaceSessionsPanel.ID = exports.WORKSPACE_SESSIONS_PANEL_ID;
WorkspaceSessionsPanel.LABEL = exports.WORKSPACE_SESSIONS_PANEL_LABEL;
__decorate([
    (0, inversify_1.inject)(WorkspaceSessionsModel),
    __metadata("design:type", WorkspaceSessionsModel)
], WorkspaceSessionsPanel.prototype, "model", void 0);
__decorate([
    (0, inversify_1.postConstruct)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], WorkspaceSessionsPanel.prototype, "init", null);
exports.WorkspaceSessionsPanel = WorkspaceSessionsPanel = __decorate([
    (0, inversify_1.injectable)()
], WorkspaceSessionsPanel);
//# sourceMappingURL=workspace-sessions-panel.js.map