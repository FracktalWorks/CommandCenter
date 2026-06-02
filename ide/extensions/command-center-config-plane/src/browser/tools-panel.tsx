import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser';
import {
    ToolDefinition,
    ToolDraft,
    ToolKind,
    ToolParamSpec,
    ToolRuntime,
} from '../common/config-plane-protocol';
import { ToolsModel } from './tools-model';
import { TOOLS_PANEL_ID, TOOLS_ICON } from './tools-view-container';

// ---------------------------------------------------------------------------
// Styles (consistent with agents-panel / integration-widgets)
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
    padding: '10px 12px',
    overflow: 'auto',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
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

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.82em',
    opacity: 0.85,
    margin: '6px 0 3px',
};

const METHOD_COLORS: Record<string, string> = {
    GET: 'var(--theia-charts-green, #388a34)',
    POST: 'var(--theia-charts-blue, #0063b1)',
    PUT: 'var(--theia-charts-orange, #bf8803)',
    PATCH: 'var(--theia-charts-purple, #68217a)',
    DELETE: 'var(--theia-editorError-foreground, #e51400)',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ToolRowProps {
    tool: ToolDefinition;
    integrationName: string;
    onEdit: () => void;
    onDelete: () => void;
}

const ToolRow: React.FC<ToolRowProps> = ({ tool, integrationName, onEdit, onDelete }) => (
    <div
        style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '8px 10px',
            borderRadius: '6px',
            background: 'var(--theia-list-hoverBackground)',
            marginBottom: '6px',
        }}
    >
        <span
            className={codicon(tool.enabled ? 'tools' : 'circle-slash')}
            style={{ marginTop: '2px', opacity: tool.enabled ? 1 : 0.4, flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: '0.92em' }}>{tool.name}</strong>
                <span
                    style={{
                        fontSize: '0.72em',
                        fontWeight: 700,
                        padding: '0 5px',
                        borderRadius: '4px',
                        background: 'var(--theia-badge-background)',
                        color: (tool.kind ?? 'http') === 'script' ? 'var(--theia-charts-purple, #68217a)' : (METHOD_COLORS[tool.method ?? 'GET'] ?? 'inherit'),
                    }}
                >
                    {(tool.kind ?? 'http') === 'script' ? (tool.runtime ?? 'script').toUpperCase() : tool.method}
                </span>
                {!tool.enabled && (
                    <span style={{ fontSize: '0.72em', opacity: 0.5 }}>disabled</span>
                )}
            </div>
            <div style={{ fontSize: '0.78em', opacity: 0.65, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(tool.kind ?? 'http') === 'script'
                    ? `script${tool.requirements?.length ? ' · ' + tool.requirements.join(', ') : ''}`
                    : `${integrationName} · ${tool.path}`}
            </div>
            {tool.description && (
                <div style={{ fontSize: '0.8em', opacity: 0.8, marginTop: '3px' }}>
                    {tool.description}
                </div>
            )}
            {tool.params.length > 0 && (
                <div style={{ fontSize: '0.76em', opacity: 0.6, marginTop: '3px' }}>
                    Params: {tool.params.map(p => `${p.key}${p.required ? '*' : ''}(${p.location})`).join(', ')}
                </div>
            )}
        </div>
        <button
            className='theia-button secondary'
            title='Edit'
            onClick={e => { e.stopPropagation(); onEdit(); }}
            style={{ padding: '2px 7px', minWidth: 0 }}
        >
            <span className={codicon('edit')} />
        </button>
        <button
            className='theia-button secondary'
            title='Delete'
            onClick={e => { e.stopPropagation(); onDelete(); }}
            style={{ padding: '2px 7px', minWidth: 0, color: 'var(--theia-editorError-foreground)' }}
        >
            <span className={codicon('trash')} />
        </button>
    </div>
);

// ---------------------------------------------------------------------------
// Param editor sub-form
// ---------------------------------------------------------------------------

interface ParamEditorProps {
    params: ToolParamSpec[];
    onChange: (params: ToolParamSpec[]) => void;
}

const ParamEditor: React.FC<ParamEditorProps> = ({ params, onChange }) => {
    const add = () => onChange([
        ...params,
        { key: '', label: '', description: '', type: 'string', required: true, location: 'query' },
    ]);
    const remove = (i: number) => onChange(params.filter((_, idx) => idx !== i));
    const update = (i: number, field: keyof ToolParamSpec, value: string | boolean) => {
        const next = params.map((p, idx) => idx === i ? { ...p, [field]: value } : p);
        onChange(next);
    };
    return (
        <div style={{ marginTop: '4px' }}>
            {params.map((p, i) => (
                <div key={i} style={{
                    background: 'var(--theia-editorWidget-background)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    marginBottom: '6px',
                    fontSize: '0.85em',
                }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                        <div>
                            <label style={labelStyle}>Key *</label>
                            <input style={{ ...inputStyle, marginBottom: '2px' }} value={p.key}
                                onChange={e => update(i, 'key', e.target.value)} placeholder='e.g. calendarId' />
                        </div>
                        <div>
                            <label style={labelStyle}>Label *</label>
                            <input style={{ ...inputStyle, marginBottom: '2px' }} value={p.label}
                                onChange={e => update(i, 'label', e.target.value)} placeholder='e.g. Calendar ID' />
                        </div>
                    </div>
                    <label style={labelStyle}>Description</label>
                    <input style={{ ...inputStyle, marginBottom: '2px' }} value={p.description}
                        onChange={e => update(i, 'description', e.target.value)} placeholder='Describe this parameter' />
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px' }}>
                        <div>
                            <label style={labelStyle}>Location</label>
                            <select style={{ ...inputStyle, marginBottom: '2px' }}
                                value={p.location} onChange={e => update(i, 'location', e.target.value as ToolParamSpec['location'])}>
                                <option value='query'>query</option>
                                <option value='body'>body</option>
                                <option value='path'>path</option>
                            </select>
                        </div>
                        <div>
                            <label style={labelStyle}>Type</label>
                            <select style={{ ...inputStyle, marginBottom: '2px' }}
                                value={p.type} onChange={e => update(i, 'type', e.target.value as ToolParamSpec['type'])}>
                                <option value='string'>string</option>
                                <option value='number'>number</option>
                                <option value='boolean'>boolean</option>
                            </select>
                        </div>
                        <div>
                            <label style={labelStyle}>Required</label>
                            <select style={{ ...inputStyle, marginBottom: '2px' }}
                                value={String(p.required)} onChange={e => update(i, 'required', e.target.value === 'true')}>
                                <option value='true'>yes</option>
                                <option value='false'>no</option>
                            </select>
                        </div>
                    </div>
                    <label style={labelStyle}>Default (optional)</label>
                    <div style={{ display: 'flex', gap: '4px' }}>
                        <input style={{ ...inputStyle, flex: 1, marginBottom: '2px' }} value={p.default ?? ''}
                            onChange={e => update(i, 'default', e.target.value)} placeholder='Default value' />
                        <button className='theia-button secondary' onClick={() => remove(i)}
                            style={{ padding: '2px 7px', color: 'var(--theia-editorError-foreground)' }}>
                            <span className={codicon('remove')} />
                        </button>
                    </div>
                </div>
            ))}
            <button className='theia-button secondary' onClick={add} style={{ fontSize: '0.82em', padding: '3px 10px' }}>
                <span className={codicon('add')} /> Add Parameter
            </button>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Tool form state
// ---------------------------------------------------------------------------

interface ToolFormState {
    name: string;
    description: string;
    kind: ToolKind;
    integrationId: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    runtime: ToolRuntime;
    code: string;
    files: Array<{ path: string; content: string }>;
    requirements: string;
    integrationRefs: string[];
    timeoutMs: string;
    category: string;
    params: ToolParamSpec[];
    responseDescription: string;
    enabled: boolean;
}

function emptyForm(): ToolFormState {
    return {
        name: '', description: '', kind: 'http', integrationId: '', method: 'GET', path: '',
        runtime: 'python', code: '', files: [], requirements: '', integrationRefs: [], timeoutMs: '',
        category: '',
        params: [], responseDescription: '', enabled: true,
    };
}

function toolToForm(t: ToolDefinition): ToolFormState {
    return {
        name: t.name,
        description: t.description,
        kind: t.kind ?? 'http',
        integrationId: t.integrationId ?? '',
        method: t.method ?? 'GET',
        path: t.path ?? '',
        runtime: t.runtime ?? 'python',
        code: t.code ?? '',
        files: Object.entries(t.files ?? {}).map(([path, content]) => ({ path, content })),
        requirements: (t.requirements ?? []).join(', '),
        integrationRefs: t.integrationRefs ?? [],
        timeoutMs: t.timeoutMs ? String(t.timeoutMs) : '',
        category: t.category ?? '',
        params: t.params,
        responseDescription: t.responseDescription ?? '',
        enabled: t.enabled,
    };
}

/**
 * Logical group label a tool belongs to: its explicit category, else the
 * backing integration name (http) or "Scripts" (script).
 */
function toolGroupLabel(tool: ToolDefinition, integrationName: (id: string) => string): string {
    if (tool.category?.trim()) {
        return tool.category.trim();
    }
    if ((tool.kind ?? 'http') === 'script') {
        return 'Scripts';
    }
    return tool.integrationId ? integrationName(tool.integrationId) : 'Other';
}

/** True when a tool matches a free-text query across its searchable fields. */
function toolMatchesQuery(tool: ToolDefinition, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) {
        return true;
    }
    const haystack = [
        tool.name,
        tool.description,
        tool.category,
        (tool.kind ?? 'http') === 'script' ? `script ${tool.runtime} ${(tool.requirements ?? []).join(' ')}` : `http ${tool.method} ${tool.path}`,
        tool.params.map(p => p.key).join(' '),
    ].filter(Boolean).join(' ').toLowerCase();
    return q.split(/\s+/).every(term => haystack.includes(term));
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
@injectable()
export class ToolsPanelWidget extends ReactWidget {

    static readonly ID = TOOLS_PANEL_ID;

    @inject(ToolsModel)
    protected readonly model: ToolsModel;

    /** null = list view; 'new' = create form; string = edit id */
    protected formId?: string | null = null;
    protected formState: ToolFormState = emptyForm();
    protected formError?: string;
    protected saving = false;

    /** List-view search query and the set of collapsed category groups. */
    protected searchQuery = '';
    protected collapsedGroups = new Set<string>();

    @postConstruct()
    protected init(): void {
        this.id = ToolsPanelWidget.ID;
        this.title.label = 'Tools';
        this.title.caption = 'Command Center Tools';
        this.title.iconClass = TOOLS_ICON;
        this.title.closable = true;
        this.toDispose.push(this.model.onDidChange(() => this.update()));
        this.update();
    }

    protected render(): React.ReactNode {
        if (this.formId !== null && this.formId !== undefined) {
            return this.renderForm();
        }
        return this.renderList();
    }

    // --- List view -------------------------------------------------------

    protected renderList(): React.ReactNode {
        const { tools, integrations, loading, error } = this.model;
        return (
            <div style={panelStyle}>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                    <span className={codicon('tools')} style={{ fontSize: '1.1em', opacity: 0.85 }} />
                    <strong style={{ flex: 1, fontSize: '0.95em' }}>Tools</strong>
                    {tools.length > 0 && (
                        <span style={{
                            fontSize: '0.75em', padding: '1px 7px', borderRadius: '10px',
                            background: 'var(--theia-badge-background)', color: 'var(--theia-badge-foreground)',
                        }}>
                            {tools.length}
                        </span>
                    )}
                    <button className='theia-button secondary' title='Reload' onClick={this.model.refresh}
                        disabled={loading} style={{ padding: '2px 8px', minWidth: 0 }}>
                        <span className={codicon(loading ? 'sync~spin' : 'refresh')} />
                    </button>
                    <button className='theia-button' title='New Tool' onClick={this.openCreate}
                        style={{ padding: '2px 8px', minWidth: 0 }}>
                        <span className={codicon('add')} />
                    </button>
                </div>

                {/* Hint */}
                <div style={{ fontSize: '0.8em', opacity: 0.6, marginBottom: '10px', lineHeight: 1.4 }}>
                    Tools are named actions agents invoke by name. An <strong>HTTP</strong> tool wraps one API
                    endpoint; a <strong>Script</strong> tool runs full Python/Node/Bash code that can install
                    packages, combine multiple APIs, and process files.
                </div>

                {error && (
                    <div style={{ color: 'var(--theia-editorError-foreground)', fontSize: '0.85em', marginBottom: '8px' }}>
                        {error}
                    </div>
                )}

                {integrations.filter(i => i.kind === 'api').length === 0 && !loading && (
                    <div style={{
                        padding: '10px 12px', borderRadius: '6px',
                        background: 'var(--theia-editorWidget-background)', fontSize: '0.83em', opacity: 0.75,
                        marginBottom: '10px',
                    }}>
                        No API integrations configured yet. Go to the <strong>Integrations</strong> panel and add an API
                        integration first, then come back here to create tools.
                    </div>
                )}

                {tools.length === 0 && !loading && (
                    <div style={{ fontSize: '0.85em', opacity: 0.6, textAlign: 'center', marginTop: '24px' }}>
                        No tools yet. Click <strong>+</strong> to create one.
                    </div>
                )}

                {tools.length > 0 && this.renderGroupedTools()}
            </div>
        );
    }

    /** Search box + tools grouped into collapsible category subsections. */
    protected renderGroupedTools(): React.ReactNode {
        const { tools } = this.model;
        const q = this.searchQuery;
        const filtered = tools.filter(t => toolMatchesQuery(t, q));

        // Group by category/integration label, then sort groups alphabetically.
        const groups = new Map<string, ToolDefinition[]>();
        for (const t of filtered) {
            const label = toolGroupLabel(t, id => this.model.integrationName(id));
            (groups.get(label) ?? groups.set(label, []).get(label)!).push(t);
        }
        const sortedLabels = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

        return (
            <>
                <div style={{ position: 'relative', marginBottom: '10px' }}>
                    <span className={codicon('search')} style={{ position: 'absolute', left: '7px', top: '6px', opacity: 0.5, fontSize: '0.9em' }} />
                    <input
                        style={{ ...inputStyle, marginBottom: 0, paddingLeft: '24px' }}
                        value={q}
                        placeholder='Search tools by name, category, API…'
                        onChange={e => { this.searchQuery = e.target.value; this.update(); }}
                    />
                </div>

                {filtered.length === 0 && (
                    <div style={{ fontSize: '0.85em', opacity: 0.6, textAlign: 'center', marginTop: '16px' }}>
                        No tools match “{q}”. Use <strong>+</strong> to create one.
                    </div>
                )}

                {sortedLabels.map(label => {
                    const groupTools = groups.get(label)!;
                    const collapsed = this.collapsedGroups.has(label);
                    return (
                        <div key={label} style={{ marginBottom: '8px' }}>
                            <div
                                onClick={() => this.toggleGroup(label)}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
                                    padding: '4px 2px', userSelect: 'none',
                                    fontSize: '0.8em', fontWeight: 700, textTransform: 'uppercase',
                                    letterSpacing: '0.03em', opacity: 0.8,
                                }}
                            >
                                <span className={codicon(collapsed ? 'chevron-right' : 'chevron-down')} style={{ fontSize: '0.9em' }} />
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                                <span style={{
                                    fontSize: '0.9em', fontWeight: 700, padding: '0 6px', borderRadius: '9px',
                                    background: 'var(--theia-badge-background)', color: 'var(--theia-badge-foreground)',
                                }}>{groupTools.length}</span>
                            </div>
                            {!collapsed && groupTools.map(tool => (
                                <ToolRow
                                    key={tool.id}
                                    tool={tool}
                                    integrationName={this.model.integrationName(tool.integrationId ?? '')}
                                    onEdit={() => this.openEdit(tool)}
                                    onDelete={() => this.confirmDelete(tool)}
                                />
                            ))}
                        </div>
                    );
                })}
            </>
        );
    }

    protected toggleGroup = (label: string): void => {
        if (this.collapsedGroups.has(label)) {
            this.collapsedGroups.delete(label);
        } else {
            this.collapsedGroups.add(label);
        }
        this.update();
    };

    // --- Create / Edit form ----------------------------------------------

    protected renderForm(): React.ReactNode {
        const isNew = this.formId === 'new';
        const f = this.formState;
        const apiIntegrations = this.model.integrations.filter(i => i.kind === 'api');
        const set = (k: keyof ToolFormState, v: ToolFormState[typeof k]) => {
            this.formState = { ...this.formState, [k]: v };
            this.update();
        };
        return (
            <div style={panelStyle}>
                {/* Form header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                    <button className='theia-button secondary' onClick={this.closeForm}
                        style={{ padding: '2px 8px', minWidth: 0 }}>
                        <span className={codicon('arrow-left')} />
                    </button>
                    <strong style={{ flex: 1, fontSize: '0.95em' }}>{isNew ? 'New Tool' : 'Edit Tool'}</strong>
                </div>

                {this.formError && (
                    <div style={{ color: 'var(--theia-editorError-foreground)', fontSize: '0.85em', marginBottom: '8px' }}>
                        {this.formError}
                    </div>
                )}

                <label style={labelStyle}>Name *</label>
                <input style={inputStyle} value={f.name}
                    onChange={e => set('name', e.target.value)} placeholder='e.g. List Calendar Events' />

                <label style={labelStyle}>Description</label>
                <input style={inputStyle} value={f.description}
                    onChange={e => set('description', e.target.value)} placeholder='What does this tool do?' />

                <label style={labelStyle}>Type *</label>
                <select style={inputStyle} value={f.kind}
                    onChange={e => set('kind', e.target.value as ToolKind)}>
                    <option value='http'>HTTP request (one API endpoint)</option>
                    <option value='script'>Script (Python / Node / Bash — packages, multi-API, files)</option>
                </select>

                {f.kind === 'http' ? (
                    <>
                        <label style={labelStyle}>Integration *</label>
                        <select style={inputStyle} value={f.integrationId}
                            onChange={e => set('integrationId', e.target.value)}>
                            <option value=''>— select an API integration —</option>
                            {apiIntegrations.map(i => (
                                <option key={i.id} value={i.id}>{i.name}</option>
                            ))}
                            {this.model.integrations.filter(i => i.kind !== 'api').map(i => (
                                <option key={i.id} value={i.id} disabled style={{ opacity: 0.4 }}>
                                    {i.name} (non-API)
                                </option>
                            ))}
                        </select>

                        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px' }}>
                            <div>
                                <label style={labelStyle}>Method *</label>
                                <select style={inputStyle} value={f.method}
                                    onChange={e => set('method', e.target.value as ToolFormState['method'])}>
                                    {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map(m => (
                                        <option key={m} value={m}>{m}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label style={labelStyle}>Path * (use &#123;key&#125; for path params)</label>
                                <input style={inputStyle} value={f.path}
                                    onChange={e => set('path', e.target.value)} placeholder='/calendars/{calendarId}/events' />
                            </div>
                        </div>
                    </>
                ) : (
                    <>
                        <label style={labelStyle}>Runtime *</label>
                        <select style={inputStyle} value={f.runtime}
                            onChange={e => set('runtime', e.target.value as ToolRuntime)}>
                            <option value='python'>python</option>
                            <option value='node'>node</option>
                            <option value='bash'>bash</option>
                        </select>

                        <label style={labelStyle}>Code *</label>
                        <textarea
                            style={{ ...inputStyle, minHeight: '160px', fontFamily: 'var(--theia-editor-font-family, monospace)', whiteSpace: 'pre' }}
                            value={f.code}
                            onChange={e => set('code', e.target.value)}
                            placeholder={'import os, json\nargs = json.loads(os.environ["CC_TOOL_ARGS"])\nintegrations = json.loads(os.environ.get("CC_INTEGRATIONS", "{}"))\n# ... do work ...\nprint("result")'}
                        />
                        <div style={{ fontSize: '0.74em', opacity: 0.6, marginBottom: '4px', lineHeight: 1.4 }}>
                            Read inputs from <code>CC_TOOL_ARGS</code> (JSON) &amp; <code>args.json</code>; credentials from{' '}
                            <code>CC_INTEGRATIONS</code> (JSON). Whatever you print to stdout is returned to the agent.
                        </div>

                        <label style={labelStyle}>Additional files (multi-file tool)</label>
                        <div style={{ fontSize: '0.74em', opacity: 0.6, marginBottom: '4px', lineHeight: 1.4 }}>
                            Helper modules / data written next to the entry point so it can import or read them
                            (e.g. <code>{f.runtime === 'node' ? 'lib/parse.js' : f.runtime === 'bash' ? 'helpers.sh' : 'lib/parse.py'}</code>). Paths are relative; do not use <code>main.*</code> or <code>args.json</code>.
                        </div>
                        {f.files.map((file, idx) => (
                            <div key={idx} style={{ marginBottom: '6px', border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))', borderRadius: '4px', padding: '4px 6px' }}>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '4px' }}>
                                    <input style={{ ...inputStyle, marginBottom: 0, flex: 1, fontFamily: 'var(--theia-editor-font-family, monospace)' }}
                                        value={file.path}
                                        placeholder='relative/path.py'
                                        onChange={e => set('files', f.files.map((x, i) => i === idx ? { ...x, path: e.target.value } : x))} />
                                    <button type='button' className='theia-button secondary' style={{ padding: '2px 8px' }}
                                        onClick={() => set('files', f.files.filter((_, i) => i !== idx))}>Remove</button>
                                </div>
                                <textarea
                                    style={{ ...inputStyle, marginBottom: 0, minHeight: '90px', fontFamily: 'var(--theia-editor-font-family, monospace)', whiteSpace: 'pre' }}
                                    value={file.content}
                                    placeholder='file contents'
                                    onChange={e => set('files', f.files.map((x, i) => i === idx ? { ...x, content: e.target.value } : x))} />
                            </div>
                        ))}
                        <button type='button' className='theia-button secondary' style={{ fontSize: '0.82em', padding: '3px 10px', marginBottom: '8px' }}
                            onClick={() => set('files', [...f.files, { path: '', content: '' }])}>+ Add file</button>

                        <label style={labelStyle}>Requirements (packages, comma-separated)</label>
                        <input style={inputStyle} value={f.requirements}
                            onChange={e => set('requirements', e.target.value)}
                            placeholder={f.runtime === 'node' ? 'axios, pdf-lib' : 'pdfplumber, openai'} />

                        <label style={labelStyle}>Integration credentials to inject (CC_INTEGRATIONS)</label>
                        <div style={{
                            maxHeight: '120px', overflowY: 'auto',
                            border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
                            borderRadius: '4px', padding: '4px 6px', marginBottom: '6px',
                        }}>
                            {this.model.integrations.length === 0 && (
                                <div style={{ fontSize: '0.78em', opacity: 0.6 }}>No integrations configured.</div>
                            )}
                            {this.model.integrations.map(i => {
                                const checked = f.integrationRefs.includes(i.id);
                                return (
                                    <label key={i.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82em', padding: '1px 0' }}>
                                        <input type='checkbox' checked={checked}
                                            onChange={() => set('integrationRefs',
                                                checked ? f.integrationRefs.filter(r => r !== i.id) : [...f.integrationRefs, i.id])} />
                                        {i.name} <span style={{ opacity: 0.5 }}>({i.kind})</span>
                                    </label>
                                );
                            })}
                        </div>

                        <label style={labelStyle}>Timeout ms (optional, max 600000)</label>
                        <input style={inputStyle} value={f.timeoutMs} type='number'
                            onChange={e => set('timeoutMs', e.target.value)} placeholder='120000' />
                    </>
                )}

                <label style={labelStyle}>Parameters</label>
                <ParamEditor params={f.params} onChange={params => set('params', params)} />

                <label style={{ ...labelStyle, marginTop: '10px' }}>Response description (helps agent understand output)</label>
                <input style={inputStyle} value={f.responseDescription}
                    onChange={e => set('responseDescription', e.target.value)} placeholder='e.g. Returns a list of calendar events' />

                <label style={labelStyle}>Category (groups this tool in the list)</label>
                <input style={inputStyle} value={f.category} list='cc-tool-categories'
                    onChange={e => set('category', e.target.value)}
                    placeholder={f.kind === 'http' ? 'e.g. Google Calendar' : 'e.g. Documents'} />
                <datalist id='cc-tool-categories'>
                    {Array.from(new Set(this.model.tools.map(t => t.category).filter((c): c is string => !!c)))
                        .sort().map(c => <option key={c} value={c} />)}
                </datalist>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', marginBottom: '10px' }}>
                    <input type='checkbox' id='tool-enabled' checked={f.enabled}
                        onChange={e => set('enabled', e.target.checked)} />
                    <label htmlFor='tool-enabled' style={{ fontSize: '0.85em' }}>Enabled</label>
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                    <button className='theia-button' onClick={this.save} disabled={this.saving}
                        style={{ flex: 1 }}>
                        {this.saving
                            ? <span className={codicon('sync~spin')} />
                            : (isNew ? 'Create Tool' : 'Save Changes')}
                    </button>
                    <button className='theia-button secondary' onClick={this.closeForm}>Cancel</button>
                </div>
            </div>
        );
    }

    // --- Actions ---------------------------------------------------------

    protected openCreate = () => {
        this.formId = 'new';
        this.formState = emptyForm();
        this.formError = undefined;
        this.update();
    };

    protected openEdit = (tool: ToolDefinition) => {
        this.formId = tool.id;
        this.formState = toolToForm(tool);
        this.formError = undefined;
        this.update();
    };

    protected closeForm = () => {
        this.formId = null;
        this.formError = undefined;
        this.update();
    };

    protected save = async () => {
        const f = this.formState;
        if (!f.name.trim()) { this.formError = 'Name is required.'; this.update(); return; }
        if (f.kind === 'http') {
            if (!f.integrationId) { this.formError = 'Integration is required.'; this.update(); return; }
            if (!f.path.trim()) { this.formError = 'Path is required.'; this.update(); return; }
        } else {
            if (!f.code.trim()) { this.formError = 'Code is required for a script tool.'; this.update(); return; }
            const seen = new Set<string>();
            for (const file of f.files) {
                const p = file.path.trim();
                if (!p) { this.formError = 'Every additional file needs a path.'; this.update(); return; }
                if (p === 'args.json' || p.startsWith('main.')) { this.formError = `Reserved file path: ${p}. Put the entry point in Code, not as a file.`; this.update(); return; }
                if (seen.has(p)) { this.formError = `Duplicate file path: ${p}.`; this.update(); return; }
                seen.add(p);
            }
        }
        this.saving = true;
        this.formError = undefined;
        this.update();
        try {
            const filesMap: Record<string, string> = {};
            for (const file of f.files) { filesMap[file.path.trim()] = file.content; }
            const draft: ToolDraft = f.kind === 'script'
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
            } else {
                await this.model.update(this.formId!, draft);
            }
            this.formId = null;
        } catch (e) {
            this.formError = e instanceof Error ? e.message : String(e);
        } finally {
            this.saving = false;
            this.update();
        }
    };

    protected confirmDelete = async (tool: ToolDefinition) => {
        // Simple confirmation via window.confirm (same as agents panel pattern).
        if (!window.confirm(`Delete tool "${tool.name}"?`)) return;
        try {
            await this.model.remove(tool.id);
        } catch (e) {
            console.error('[Tools] Delete failed:', e);
        }
    };
}
