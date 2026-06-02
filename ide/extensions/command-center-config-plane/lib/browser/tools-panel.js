"use strict";
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
var ToolsPanelWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolsPanelWidget = void 0;
const React = __importStar(require("@theia/core/shared/react"));
const inversify_1 = require("@theia/core/shared/inversify");
const react_widget_1 = require("@theia/core/lib/browser/widgets/react-widget");
const browser_1 = require("@theia/core/lib/browser");
const tools_model_1 = require("./tools-model");
const tools_view_container_1 = require("./tools-view-container");
// ---------------------------------------------------------------------------
// Styles (consistent with agents-panel / integration-widgets)
// ---------------------------------------------------------------------------
const panelStyle = {
    padding: '10px 12px',
    overflow: 'auto',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
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
const labelStyle = {
    display: 'block',
    fontSize: '0.82em',
    opacity: 0.85,
    margin: '6px 0 3px',
};
const METHOD_COLORS = {
    GET: 'var(--theia-charts-green, #388a34)',
    POST: 'var(--theia-charts-blue, #0063b1)',
    PUT: 'var(--theia-charts-orange, #bf8803)',
    PATCH: 'var(--theia-charts-purple, #68217a)',
    DELETE: 'var(--theia-editorError-foreground, #e51400)',
};
const ToolRow = ({ tool, integrationName, onEdit, onDelete }) => {
    var _a, _b, _c, _d, _e, _f, _g;
    return (React.createElement("div", { style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '8px 10px',
            borderRadius: '6px',
            background: 'var(--theia-list-hoverBackground)',
            marginBottom: '6px',
        } },
        React.createElement("span", { className: (0, browser_1.codicon)(tool.enabled ? 'tools' : 'circle-slash'), style: { marginTop: '2px', opacity: tool.enabled ? 1 : 0.4, flexShrink: 0 } }),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                React.createElement("strong", { style: { fontSize: '0.92em' } }, tool.name),
                React.createElement("span", { style: {
                        fontSize: '0.72em',
                        fontWeight: 700,
                        padding: '0 5px',
                        borderRadius: '4px',
                        background: 'var(--theia-badge-background)',
                        color: ((_a = tool.kind) !== null && _a !== void 0 ? _a : 'http') === 'script' ? 'var(--theia-charts-purple, #68217a)' : ((_c = METHOD_COLORS[(_b = tool.method) !== null && _b !== void 0 ? _b : 'GET']) !== null && _c !== void 0 ? _c : 'inherit'),
                    } }, ((_d = tool.kind) !== null && _d !== void 0 ? _d : 'http') === 'script' ? ((_e = tool.runtime) !== null && _e !== void 0 ? _e : 'script').toUpperCase() : tool.method),
                !tool.enabled && (React.createElement("span", { style: { fontSize: '0.72em', opacity: 0.5 } }, "disabled"))),
            React.createElement("div", { style: { fontSize: '0.78em', opacity: 0.65, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ((_f = tool.kind) !== null && _f !== void 0 ? _f : 'http') === 'script'
                ? `script${((_g = tool.requirements) === null || _g === void 0 ? void 0 : _g.length) ? ' · ' + tool.requirements.join(', ') : ''}`
                : `${integrationName} · ${tool.path}`),
            tool.description && (React.createElement("div", { style: { fontSize: '0.8em', opacity: 0.8, marginTop: '3px' } }, tool.description)),
            tool.params.length > 0 && (React.createElement("div", { style: { fontSize: '0.76em', opacity: 0.6, marginTop: '3px' } },
                "Params: ",
                tool.params.map(p => `${p.key}${p.required ? '*' : ''}(${p.location})`).join(', ')))),
        React.createElement("button", { className: 'theia-button secondary', title: 'Edit', onClick: e => { e.stopPropagation(); onEdit(); }, style: { padding: '2px 7px', minWidth: 0 } },
            React.createElement("span", { className: (0, browser_1.codicon)('edit') })),
        React.createElement("button", { className: 'theia-button secondary', title: 'Delete', onClick: e => { e.stopPropagation(); onDelete(); }, style: { padding: '2px 7px', minWidth: 0, color: 'var(--theia-editorError-foreground)' } },
            React.createElement("span", { className: (0, browser_1.codicon)('trash') }))));
};
const ParamEditor = ({ params, onChange }) => {
    const add = () => onChange([
        ...params,
        { key: '', label: '', description: '', type: 'string', required: true, location: 'query' },
    ]);
    const remove = (i) => onChange(params.filter((_, idx) => idx !== i));
    const update = (i, field, value) => {
        const next = params.map((p, idx) => idx === i ? { ...p, [field]: value } : p);
        onChange(next);
    };
    return (React.createElement("div", { style: { marginTop: '4px' } },
        params.map((p, i) => {
            var _a;
            return (React.createElement("div", { key: i, style: {
                    background: 'var(--theia-editorWidget-background)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    marginBottom: '6px',
                    fontSize: '0.85em',
                } },
                React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' } },
                    React.createElement("div", null,
                        React.createElement("label", { style: labelStyle }, "Key *"),
                        React.createElement("input", { style: { ...inputStyle, marginBottom: '2px' }, value: p.key, onChange: e => update(i, 'key', e.target.value), placeholder: 'e.g. calendarId' })),
                    React.createElement("div", null,
                        React.createElement("label", { style: labelStyle }, "Label *"),
                        React.createElement("input", { style: { ...inputStyle, marginBottom: '2px' }, value: p.label, onChange: e => update(i, 'label', e.target.value), placeholder: 'e.g. Calendar ID' }))),
                React.createElement("label", { style: labelStyle }, "Description"),
                React.createElement("input", { style: { ...inputStyle, marginBottom: '2px' }, value: p.description, onChange: e => update(i, 'description', e.target.value), placeholder: 'Describe this parameter' }),
                React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px' } },
                    React.createElement("div", null,
                        React.createElement("label", { style: labelStyle }, "Location"),
                        React.createElement("select", { style: { ...inputStyle, marginBottom: '2px' }, value: p.location, onChange: e => update(i, 'location', e.target.value) },
                            React.createElement("option", { value: 'query' }, "query"),
                            React.createElement("option", { value: 'body' }, "body"),
                            React.createElement("option", { value: 'path' }, "path"))),
                    React.createElement("div", null,
                        React.createElement("label", { style: labelStyle }, "Type"),
                        React.createElement("select", { style: { ...inputStyle, marginBottom: '2px' }, value: p.type, onChange: e => update(i, 'type', e.target.value) },
                            React.createElement("option", { value: 'string' }, "string"),
                            React.createElement("option", { value: 'number' }, "number"),
                            React.createElement("option", { value: 'boolean' }, "boolean"))),
                    React.createElement("div", null,
                        React.createElement("label", { style: labelStyle }, "Required"),
                        React.createElement("select", { style: { ...inputStyle, marginBottom: '2px' }, value: String(p.required), onChange: e => update(i, 'required', e.target.value === 'true') },
                            React.createElement("option", { value: 'true' }, "yes"),
                            React.createElement("option", { value: 'false' }, "no")))),
                React.createElement("label", { style: labelStyle }, "Default (optional)"),
                React.createElement("div", { style: { display: 'flex', gap: '4px' } },
                    React.createElement("input", { style: { ...inputStyle, flex: 1, marginBottom: '2px' }, value: (_a = p.default) !== null && _a !== void 0 ? _a : '', onChange: e => update(i, 'default', e.target.value), placeholder: 'Default value' }),
                    React.createElement("button", { className: 'theia-button secondary', onClick: () => remove(i), style: { padding: '2px 7px', color: 'var(--theia-editorError-foreground)' } },
                        React.createElement("span", { className: (0, browser_1.codicon)('remove') })))));
        }),
        React.createElement("button", { className: 'theia-button secondary', onClick: add, style: { fontSize: '0.82em', padding: '3px 10px' } },
            React.createElement("span", { className: (0, browser_1.codicon)('add') }),
            " Add Parameter")));
};
function emptyForm() {
    return {
        name: '', description: '', kind: 'http', integrationId: '', method: 'GET', path: '',
        runtime: 'python', code: '', files: [], requirements: '', integrationRefs: [], timeoutMs: '',
        category: '',
        params: [], responseDescription: '', enabled: true,
    };
}
function toolToForm(t) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    return {
        name: t.name,
        description: t.description,
        kind: (_a = t.kind) !== null && _a !== void 0 ? _a : 'http',
        integrationId: (_b = t.integrationId) !== null && _b !== void 0 ? _b : '',
        method: (_c = t.method) !== null && _c !== void 0 ? _c : 'GET',
        path: (_d = t.path) !== null && _d !== void 0 ? _d : '',
        runtime: (_e = t.runtime) !== null && _e !== void 0 ? _e : 'python',
        code: (_f = t.code) !== null && _f !== void 0 ? _f : '',
        files: Object.entries((_g = t.files) !== null && _g !== void 0 ? _g : {}).map(([path, content]) => ({ path, content })),
        requirements: ((_h = t.requirements) !== null && _h !== void 0 ? _h : []).join(', '),
        integrationRefs: (_j = t.integrationRefs) !== null && _j !== void 0 ? _j : [],
        timeoutMs: t.timeoutMs ? String(t.timeoutMs) : '',
        category: (_k = t.category) !== null && _k !== void 0 ? _k : '',
        params: t.params,
        responseDescription: (_l = t.responseDescription) !== null && _l !== void 0 ? _l : '',
        enabled: t.enabled,
    };
}
/**
 * Logical group label a tool belongs to: its explicit category, else the
 * backing integration name (http) or "Scripts" (script).
 */
function toolGroupLabel(tool, integrationName) {
    var _a, _b;
    if ((_a = tool.category) === null || _a === void 0 ? void 0 : _a.trim()) {
        return tool.category.trim();
    }
    if (((_b = tool.kind) !== null && _b !== void 0 ? _b : 'http') === 'script') {
        return 'Scripts';
    }
    return tool.integrationId ? integrationName(tool.integrationId) : 'Other';
}
/** True when a tool matches a free-text query across its searchable fields. */
function toolMatchesQuery(tool, query) {
    var _a, _b;
    const q = query.trim().toLowerCase();
    if (!q) {
        return true;
    }
    const haystack = [
        tool.name,
        tool.description,
        tool.category,
        ((_a = tool.kind) !== null && _a !== void 0 ? _a : 'http') === 'script' ? `script ${tool.runtime} ${((_b = tool.requirements) !== null && _b !== void 0 ? _b : []).join(' ')}` : `http ${tool.method} ${tool.path}`,
        tool.params.map(p => p.key).join(' '),
    ].filter(Boolean).join(' ').toLowerCase();
    return q.split(/\s+/).every(term => haystack.includes(term));
}
// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
let ToolsPanelWidget = ToolsPanelWidget_1 = class ToolsPanelWidget extends react_widget_1.ReactWidget {
    constructor() {
        super(...arguments);
        /** null = list view; 'new' = create form; string = edit id */
        this.formId = null;
        this.formState = emptyForm();
        this.saving = false;
        /** List-view search query and the set of collapsed category groups. */
        this.searchQuery = '';
        this.collapsedGroups = new Set();
        this.toggleGroup = (label) => {
            if (this.collapsedGroups.has(label)) {
                this.collapsedGroups.delete(label);
            }
            else {
                this.collapsedGroups.add(label);
            }
            this.update();
        };
        // --- Actions ---------------------------------------------------------
        this.openCreate = () => {
            this.formId = 'new';
            this.formState = emptyForm();
            this.formError = undefined;
            this.update();
        };
        this.openEdit = (tool) => {
            this.formId = tool.id;
            this.formState = toolToForm(tool);
            this.formError = undefined;
            this.update();
        };
        this.closeForm = () => {
            this.formId = null;
            this.formError = undefined;
            this.update();
        };
        this.save = async () => {
            const f = this.formState;
            if (!f.name.trim()) {
                this.formError = 'Name is required.';
                this.update();
                return;
            }
            if (f.kind === 'http') {
                if (!f.integrationId) {
                    this.formError = 'Integration is required.';
                    this.update();
                    return;
                }
                if (!f.path.trim()) {
                    this.formError = 'Path is required.';
                    this.update();
                    return;
                }
            }
            else {
                if (!f.code.trim()) {
                    this.formError = 'Code is required for a script tool.';
                    this.update();
                    return;
                }
                const seen = new Set();
                for (const file of f.files) {
                    const p = file.path.trim();
                    if (!p) {
                        this.formError = 'Every additional file needs a path.';
                        this.update();
                        return;
                    }
                    if (p === 'args.json' || p.startsWith('main.')) {
                        this.formError = `Reserved file path: ${p}. Put the entry point in Code, not as a file.`;
                        this.update();
                        return;
                    }
                    if (seen.has(p)) {
                        this.formError = `Duplicate file path: ${p}.`;
                        this.update();
                        return;
                    }
                    seen.add(p);
                }
            }
            this.saving = true;
            this.formError = undefined;
            this.update();
            try {
                const filesMap = {};
                for (const file of f.files) {
                    filesMap[file.path.trim()] = file.content;
                }
                const draft = f.kind === 'script'
                    ? {
                        name: f.name.trim(),
                        description: f.description.trim(),
                        kind: 'script',
                        runtime: f.runtime,
                        code: f.code,
                        files: filesMap,
                        requirements: f.requirements.split(',').map(s => s.trim()).filter(Boolean),
                        integrationRefs: f.integrationRefs,
                        timeoutMs: f.timeoutMs.trim() ? Number(f.timeoutMs) : undefined,
                        params: f.params,
                        responseDescription: f.responseDescription.trim() || undefined,
                        category: f.category.trim() || undefined,
                        enabled: f.enabled,
                    }
                    : {
                        name: f.name.trim(),
                        description: f.description.trim(),
                        kind: 'http',
                        integrationId: f.integrationId,
                        method: f.method,
                        path: f.path.trim(),
                        params: f.params,
                        responseDescription: f.responseDescription.trim() || undefined,
                        category: f.category.trim() || undefined,
                        enabled: f.enabled,
                    };
                if (this.formId === 'new') {
                    await this.model.create(draft);
                }
                else {
                    await this.model.update(this.formId, draft);
                }
                this.formId = null;
            }
            catch (e) {
                this.formError = e instanceof Error ? e.message : String(e);
            }
            finally {
                this.saving = false;
                this.update();
            }
        };
        this.confirmDelete = async (tool) => {
            // Simple confirmation via window.confirm (same as agents panel pattern).
            if (!window.confirm(`Delete tool "${tool.name}"?`))
                return;
            try {
                await this.model.remove(tool.id);
            }
            catch (e) {
                console.error('[Tools] Delete failed:', e);
            }
        };
    }
    init() {
        this.id = ToolsPanelWidget_1.ID;
        this.title.label = 'Tools';
        this.title.caption = 'Command Center Tools';
        this.title.iconClass = tools_view_container_1.TOOLS_ICON;
        this.title.closable = true;
        this.toDispose.push(this.model.onDidChange(() => this.update()));
        this.update();
    }
    render() {
        if (this.formId !== null && this.formId !== undefined) {
            return this.renderForm();
        }
        return this.renderList();
    }
    // --- List view -------------------------------------------------------
    renderList() {
        const { tools, integrations, loading, error } = this.model;
        return (React.createElement("div", { style: panelStyle },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
                React.createElement("span", { className: (0, browser_1.codicon)('tools'), style: { fontSize: '1.1em', opacity: 0.85 } }),
                React.createElement("strong", { style: { flex: 1, fontSize: '0.95em' } }, "Tools"),
                tools.length > 0 && (React.createElement("span", { style: {
                        fontSize: '0.75em', padding: '1px 7px', borderRadius: '10px',
                        background: 'var(--theia-badge-background)', color: 'var(--theia-badge-foreground)',
                    } }, tools.length)),
                React.createElement("button", { className: 'theia-button secondary', title: 'Reload', onClick: this.model.refresh, disabled: loading, style: { padding: '2px 8px', minWidth: 0 } },
                    React.createElement("span", { className: (0, browser_1.codicon)(loading ? 'sync~spin' : 'refresh') })),
                React.createElement("button", { className: 'theia-button', title: 'New Tool', onClick: this.openCreate, style: { padding: '2px 8px', minWidth: 0 } },
                    React.createElement("span", { className: (0, browser_1.codicon)('add') }))),
            React.createElement("div", { style: { fontSize: '0.8em', opacity: 0.6, marginBottom: '10px', lineHeight: 1.4 } },
                "Tools are named actions agents invoke by name. An ",
                React.createElement("strong", null, "HTTP"),
                " tool wraps one API endpoint; a ",
                React.createElement("strong", null, "Script"),
                " tool runs full Python/Node/Bash code that can install packages, combine multiple APIs, and process files."),
            error && (React.createElement("div", { style: { color: 'var(--theia-editorError-foreground)', fontSize: '0.85em', marginBottom: '8px' } }, error)),
            integrations.filter(i => i.kind === 'api').length === 0 && !loading && (React.createElement("div", { style: {
                    padding: '10px 12px', borderRadius: '6px',
                    background: 'var(--theia-editorWidget-background)', fontSize: '0.83em', opacity: 0.75,
                    marginBottom: '10px',
                } },
                "No API integrations configured yet. Go to the ",
                React.createElement("strong", null, "Integrations"),
                " panel and add an API integration first, then come back here to create tools.")),
            tools.length === 0 && !loading && (React.createElement("div", { style: { fontSize: '0.85em', opacity: 0.6, textAlign: 'center', marginTop: '24px' } },
                "No tools yet. Click ",
                React.createElement("strong", null, "+"),
                " to create one.")),
            tools.length > 0 && this.renderGroupedTools()));
    }
    /** Search box + tools grouped into collapsible category subsections. */
    renderGroupedTools() {
        var _a;
        const { tools } = this.model;
        const q = this.searchQuery;
        const filtered = tools.filter(t => toolMatchesQuery(t, q));
        // Group by category/integration label, then sort groups alphabetically.
        const groups = new Map();
        for (const t of filtered) {
            const label = toolGroupLabel(t, id => this.model.integrationName(id));
            ((_a = groups.get(label)) !== null && _a !== void 0 ? _a : groups.set(label, []).get(label)).push(t);
        }
        const sortedLabels = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
        return (React.createElement(React.Fragment, null,
            React.createElement("div", { style: { position: 'relative', marginBottom: '10px' } },
                React.createElement("span", { className: (0, browser_1.codicon)('search'), style: { position: 'absolute', left: '7px', top: '6px', opacity: 0.5, fontSize: '0.9em' } }),
                React.createElement("input", { style: { ...inputStyle, marginBottom: 0, paddingLeft: '24px' }, value: q, placeholder: 'Search tools by name, category, API\u2026', onChange: e => { this.searchQuery = e.target.value; this.update(); } })),
            filtered.length === 0 && (React.createElement("div", { style: { fontSize: '0.85em', opacity: 0.6, textAlign: 'center', marginTop: '16px' } },
                "No tools match \u201C",
                q,
                "\u201D. Use ",
                React.createElement("strong", null, "+"),
                " to create one.")),
            sortedLabels.map(label => {
                const groupTools = groups.get(label);
                const collapsed = this.collapsedGroups.has(label);
                return (React.createElement("div", { key: label, style: { marginBottom: '8px' } },
                    React.createElement("div", { onClick: () => this.toggleGroup(label), style: {
                            display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
                            padding: '4px 2px', userSelect: 'none',
                            fontSize: '0.8em', fontWeight: 700, textTransform: 'uppercase',
                            letterSpacing: '0.03em', opacity: 0.8,
                        } },
                        React.createElement("span", { className: (0, browser_1.codicon)(collapsed ? 'chevron-right' : 'chevron-down'), style: { fontSize: '0.9em' } }),
                        React.createElement("span", { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
                        React.createElement("span", { style: {
                                fontSize: '0.9em', fontWeight: 700, padding: '0 6px', borderRadius: '9px',
                                background: 'var(--theia-badge-background)', color: 'var(--theia-badge-foreground)',
                            } }, groupTools.length)),
                    !collapsed && groupTools.map(tool => {
                        var _a;
                        return (React.createElement(ToolRow, { key: tool.id, tool: tool, integrationName: this.model.integrationName((_a = tool.integrationId) !== null && _a !== void 0 ? _a : ''), onEdit: () => this.openEdit(tool), onDelete: () => this.confirmDelete(tool) }));
                    })));
            })));
    }
    // --- Create / Edit form ----------------------------------------------
    renderForm() {
        const isNew = this.formId === 'new';
        const f = this.formState;
        const apiIntegrations = this.model.integrations.filter(i => i.kind === 'api');
        const set = (k, v) => {
            this.formState = { ...this.formState, [k]: v };
            this.update();
        };
        return (React.createElement("div", { style: panelStyle },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
                React.createElement("button", { className: 'theia-button secondary', onClick: this.closeForm, style: { padding: '2px 8px', minWidth: 0 } },
                    React.createElement("span", { className: (0, browser_1.codicon)('arrow-left') })),
                React.createElement("strong", { style: { flex: 1, fontSize: '0.95em' } }, isNew ? 'New Tool' : 'Edit Tool')),
            this.formError && (React.createElement("div", { style: { color: 'var(--theia-editorError-foreground)', fontSize: '0.85em', marginBottom: '8px' } }, this.formError)),
            React.createElement("label", { style: labelStyle }, "Name *"),
            React.createElement("input", { style: inputStyle, value: f.name, onChange: e => set('name', e.target.value), placeholder: 'e.g. List Calendar Events' }),
            React.createElement("label", { style: labelStyle }, "Description"),
            React.createElement("input", { style: inputStyle, value: f.description, onChange: e => set('description', e.target.value), placeholder: 'What does this tool do?' }),
            React.createElement("label", { style: labelStyle }, "Type *"),
            React.createElement("select", { style: inputStyle, value: f.kind, onChange: e => set('kind', e.target.value) },
                React.createElement("option", { value: 'http' }, "HTTP request (one API endpoint)"),
                React.createElement("option", { value: 'script' }, "Script (Python / Node / Bash \u2014 packages, multi-API, files)")),
            f.kind === 'http' ? (React.createElement(React.Fragment, null,
                React.createElement("label", { style: labelStyle }, "Integration *"),
                React.createElement("select", { style: inputStyle, value: f.integrationId, onChange: e => set('integrationId', e.target.value) },
                    React.createElement("option", { value: '' }, "\u2014 select an API integration \u2014"),
                    apiIntegrations.map(i => (React.createElement("option", { key: i.id, value: i.id }, i.name))),
                    this.model.integrations.filter(i => i.kind !== 'api').map(i => (React.createElement("option", { key: i.id, value: i.id, disabled: true, style: { opacity: 0.4 } },
                        i.name,
                        " (non-API)")))),
                React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px' } },
                    React.createElement("div", null,
                        React.createElement("label", { style: labelStyle }, "Method *"),
                        React.createElement("select", { style: inputStyle, value: f.method, onChange: e => set('method', e.target.value) }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => (React.createElement("option", { key: m, value: m }, m))))),
                    React.createElement("div", null,
                        React.createElement("label", { style: labelStyle }, "Path * (use {key} for path params)"),
                        React.createElement("input", { style: inputStyle, value: f.path, onChange: e => set('path', e.target.value), placeholder: '/calendars/{calendarId}/events' }))))) : (React.createElement(React.Fragment, null,
                React.createElement("label", { style: labelStyle }, "Runtime *"),
                React.createElement("select", { style: inputStyle, value: f.runtime, onChange: e => set('runtime', e.target.value) },
                    React.createElement("option", { value: 'python' }, "python"),
                    React.createElement("option", { value: 'node' }, "node"),
                    React.createElement("option", { value: 'bash' }, "bash")),
                React.createElement("label", { style: labelStyle }, "Code *"),
                React.createElement("textarea", { style: { ...inputStyle, minHeight: '160px', fontFamily: 'var(--theia-editor-font-family, monospace)', whiteSpace: 'pre' }, value: f.code, onChange: e => set('code', e.target.value), placeholder: 'import os, json\nargs = json.loads(os.environ["CC_TOOL_ARGS"])\nintegrations = json.loads(os.environ.get("CC_INTEGRATIONS", "{}"))\n# ... do work ...\nprint("result")' }),
                React.createElement("div", { style: { fontSize: '0.74em', opacity: 0.6, marginBottom: '4px', lineHeight: 1.4 } },
                    "Read inputs from ",
                    React.createElement("code", null, "CC_TOOL_ARGS"),
                    " (JSON) & ",
                    React.createElement("code", null, "args.json"),
                    "; credentials from",
                    ' ',
                    React.createElement("code", null, "CC_INTEGRATIONS"),
                    " (JSON). Whatever you print to stdout is returned to the agent."),
                React.createElement("label", { style: labelStyle }, "Additional files (multi-file tool)"),
                React.createElement("div", { style: { fontSize: '0.74em', opacity: 0.6, marginBottom: '4px', lineHeight: 1.4 } },
                    "Helper modules / data written next to the entry point so it can import or read them (e.g. ",
                    React.createElement("code", null, f.runtime === 'node' ? 'lib/parse.js' : f.runtime === 'bash' ? 'helpers.sh' : 'lib/parse.py'),
                    "). Paths are relative; do not use ",
                    React.createElement("code", null, "main.*"),
                    " or ",
                    React.createElement("code", null, "args.json"),
                    "."),
                f.files.map((file, idx) => (React.createElement("div", { key: idx, style: { marginBottom: '6px', border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))', borderRadius: '4px', padding: '4px 6px' } },
                    React.createElement("div", { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '4px' } },
                        React.createElement("input", { style: { ...inputStyle, marginBottom: 0, flex: 1, fontFamily: 'var(--theia-editor-font-family, monospace)' }, value: file.path, placeholder: 'relative/path.py', onChange: e => set('files', f.files.map((x, i) => i === idx ? { ...x, path: e.target.value } : x)) }),
                        React.createElement("button", { type: 'button', className: 'theia-button secondary', style: { padding: '2px 8px' }, onClick: () => set('files', f.files.filter((_, i) => i !== idx)) }, "Remove")),
                    React.createElement("textarea", { style: { ...inputStyle, marginBottom: 0, minHeight: '90px', fontFamily: 'var(--theia-editor-font-family, monospace)', whiteSpace: 'pre' }, value: file.content, placeholder: 'file contents', onChange: e => set('files', f.files.map((x, i) => i === idx ? { ...x, content: e.target.value } : x)) })))),
                React.createElement("button", { type: 'button', className: 'theia-button secondary', style: { fontSize: '0.82em', padding: '3px 10px', marginBottom: '8px' }, onClick: () => set('files', [...f.files, { path: '', content: '' }]) }, "+ Add file"),
                React.createElement("label", { style: labelStyle }, "Requirements (packages, comma-separated)"),
                React.createElement("input", { style: inputStyle, value: f.requirements, onChange: e => set('requirements', e.target.value), placeholder: f.runtime === 'node' ? 'axios, pdf-lib' : 'pdfplumber, openai' }),
                React.createElement("label", { style: labelStyle }, "Integration credentials to inject (CC_INTEGRATIONS)"),
                React.createElement("div", { style: {
                        maxHeight: '120px', overflowY: 'auto',
                        border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
                        borderRadius: '4px', padding: '4px 6px', marginBottom: '6px',
                    } },
                    this.model.integrations.length === 0 && (React.createElement("div", { style: { fontSize: '0.78em', opacity: 0.6 } }, "No integrations configured.")),
                    this.model.integrations.map(i => {
                        const checked = f.integrationRefs.includes(i.id);
                        return (React.createElement("label", { key: i.id, style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82em', padding: '1px 0' } },
                            React.createElement("input", { type: 'checkbox', checked: checked, onChange: () => set('integrationRefs', checked ? f.integrationRefs.filter(r => r !== i.id) : [...f.integrationRefs, i.id]) }),
                            i.name,
                            " ",
                            React.createElement("span", { style: { opacity: 0.5 } },
                                "(",
                                i.kind,
                                ")")));
                    })),
                React.createElement("label", { style: labelStyle }, "Timeout ms (optional, max 600000)"),
                React.createElement("input", { style: inputStyle, value: f.timeoutMs, type: 'number', onChange: e => set('timeoutMs', e.target.value), placeholder: '120000' }))),
            React.createElement("label", { style: labelStyle }, "Parameters"),
            React.createElement(ParamEditor, { params: f.params, onChange: params => set('params', params) }),
            React.createElement("label", { style: { ...labelStyle, marginTop: '10px' } }, "Response description (helps agent understand output)"),
            React.createElement("input", { style: inputStyle, value: f.responseDescription, onChange: e => set('responseDescription', e.target.value), placeholder: 'e.g. Returns a list of calendar events' }),
            React.createElement("label", { style: labelStyle }, "Category (groups this tool in the list)"),
            React.createElement("input", { style: inputStyle, value: f.category, list: 'cc-tool-categories', onChange: e => set('category', e.target.value), placeholder: f.kind === 'http' ? 'e.g. Google Calendar' : 'e.g. Documents' }),
            React.createElement("datalist", { id: 'cc-tool-categories' }, Array.from(new Set(this.model.tools.map(t => t.category).filter((c) => !!c)))
                .sort().map(c => React.createElement("option", { key: c, value: c }))),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', marginBottom: '10px' } },
                React.createElement("input", { type: 'checkbox', id: 'tool-enabled', checked: f.enabled, onChange: e => set('enabled', e.target.checked) }),
                React.createElement("label", { htmlFor: 'tool-enabled', style: { fontSize: '0.85em' } }, "Enabled")),
            React.createElement("div", { style: { display: 'flex', gap: '8px' } },
                React.createElement("button", { className: 'theia-button', onClick: this.save, disabled: this.saving, style: { flex: 1 } }, this.saving
                    ? React.createElement("span", { className: (0, browser_1.codicon)('sync~spin') })
                    : (isNew ? 'Create Tool' : 'Save Changes')),
                React.createElement("button", { className: 'theia-button secondary', onClick: this.closeForm }, "Cancel"))));
    }
};
exports.ToolsPanelWidget = ToolsPanelWidget;
ToolsPanelWidget.ID = tools_view_container_1.TOOLS_PANEL_ID;
__decorate([
    (0, inversify_1.inject)(tools_model_1.ToolsModel),
    __metadata("design:type", tools_model_1.ToolsModel)
], ToolsPanelWidget.prototype, "model", void 0);
__decorate([
    (0, inversify_1.postConstruct)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], ToolsPanelWidget.prototype, "init", null);
exports.ToolsPanelWidget = ToolsPanelWidget = ToolsPanelWidget_1 = __decorate([
    (0, inversify_1.injectable)()
], ToolsPanelWidget);
//# sourceMappingURL=tools-panel.js.map