import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser';
import { AgentDefinition, AgentDirective, AgentDraft, AgentSoul, SkillSummary, ToolDefinition } from '../common/config-plane-protocol';
import { TrustScore } from '../common/agent-intelligence';
import { AgentsModel } from './agents-model';

export const AGENTS_PANEL_ID = 'commandCenter.agents-panel';

// ---------------------------------------------------------------------------
// Helpers
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

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.82em',
    opacity: 0.85,
    margin: '6px 0 3px',
};

/** Human-readable label for a model ID. */
function modelLabel(id: string): string {
    return id
        .replace('gemini-', 'Gemini ')
        .replace('-flash-preview', ' Flash Preview')
        .replace('-flash', ' Flash')
        .replace('-pro-preview', ' Pro Preview')
        .replace('-pro', ' Pro');
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface AgentRowProps {
    agent: AgentDefinition;
    isActive: boolean;
    trust?: TrustScore;
    onSwitch: () => void;
    onDelete: () => void;
    onEdit: () => void;
}

/** Map a trust band to a theme colour token. */
const TRUST_COLORS: Record<TrustScore['band'], string> = {
    unrated: 'var(--theia-descriptionForeground)',
    poor: 'var(--theia-editorError-foreground, #e51400)',
    fair: 'var(--theia-editorWarning-foreground, #bf8803)',
    good: 'var(--theia-charts-green, #388a34)',
    excellent: 'var(--theia-charts-green, #388a34)',
};

/** Small pill showing an agent's recency-weighted trust score. */
const TrustBadge: React.FC<{ trust: TrustScore }> = ({ trust }) => {
    const label = trust.band === 'unrated'
        ? 'unrated'
        : `${trust.score}% trust`;
    const tip = trust.total === 0
        ? 'No feedback yet — rate responses with 👍/👎 in chat to build a trust score.'
        : `Trust ${trust.score}/100 (${trust.band}) from ${trust.total} rating${trust.total === 1 ? '' : 's'}: ${trust.positive}👍 / ${trust.negative}👎`;
    return (
        <span
            title={tip}
            style={{
                fontSize: '0.66em',
                padding: '0 5px',
                borderRadius: '8px',
                border: `1px solid ${TRUST_COLORS[trust.band]}`,
                color: TRUST_COLORS[trust.band],
                whiteSpace: 'nowrap',
            }}
        >
            {label}
        </span>
    );
};

const AgentRow: React.FC<AgentRowProps> = ({ agent, isActive, trust, onSwitch, onDelete, onEdit }) => (
    <div
        onClick={onSwitch}
        style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '8px 10px',
            borderRadius: '6px',
            cursor: 'pointer',
            background: isActive ? 'var(--theia-list-activeSelectionBackground)' : 'transparent',
            color: isActive ? 'var(--theia-list-activeSelectionForeground)' : 'inherit',
            marginBottom: '2px',
        }}
        title={isActive ? `${agent.name} — active` : `Switch to ${agent.name}`}
    >
        <span
            className={codicon(agent.id === 'agent-creator' ? 'beaker' : 'robot')}
            style={{ marginTop: '1px', opacity: 0.8, flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontWeight: 500, fontSize: '0.92em' }}>{agent.name}</span>
                {isActive && (
                    <span className={codicon('check')} style={{ fontSize: '0.8em', opacity: 0.8 }} />
                )}
                {agent.builtin && (
                    <span
                        style={{
                            fontSize: '0.68em',
                            padding: '0 5px',
                            borderRadius: '8px',
                            background: 'var(--theia-badge-background)',
                            color: 'var(--theia-badge-foreground)',
                        }}
                    >
                        built-in
                    </span>
                )}
                {trust && <TrustBadge trust={trust} />}
            </div>
            <div style={{ fontSize: '0.78em', opacity: 0.65, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {agent.description}
            </div>
            <div style={{ fontSize: '0.72em', opacity: 0.5, marginTop: '2px' }}>
                {agent.defaultLLM}
            </div>
        </div>
        <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
            <button
                className='theia-button secondary'
                title='Edit agent'
                onClick={onEdit}
                style={{ padding: '2px 5px', minWidth: 0 }}
            >
                <span className={codicon('edit')} />
            </button>
            <button
                className='theia-button secondary'
                title={agent.builtin ? 'Built-in agents cannot be deleted' : 'Delete agent'}
                onClick={onDelete}
                disabled={!!agent.builtin}
                style={{ padding: '2px 5px', minWidth: 0 }}
            >
                <span className={codicon('trash')} />
            </button>
        </div>
    </div>
);

// ---------------------------------------------------------------------------
// Create / Edit form
// ---------------------------------------------------------------------------

// -- Soul editor sub-component -------------------------------------------

interface SoulEditorProps {
    soul: AgentSoul;
    onChange: (s: AgentSoul) => void;
    disabled?: boolean;
}

const SoulEditor: React.FC<SoulEditorProps> = ({ soul, onChange, disabled }) => {
    const update = (key: keyof AgentSoul, value: string | string[] | undefined) =>
        onChange({ ...soul, [key]: value });

    const [coreValuesText, setCoreValuesText] = React.useState(
        (soul.coreValues ?? []).join('\n')
    );

    return (
        <div style={{
            border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
            borderRadius: '4px',
            padding: '8px',
            marginBottom: '8px',
        }}>
            <div style={{ fontSize: '0.78em', fontWeight: 600, opacity: 0.7, marginBottom: '6px' }}>
                SOUL — stable identity context compiled into the prompt
            </div>
            <label style={labelStyle}>Role title</label>
            <input
                style={inputStyle}
                value={soul.role ?? ''}
                onChange={e => update('role', e.target.value || undefined)}
                placeholder='e.g. Sales Intelligence Agent'
                disabled={disabled}
            />
            <label style={labelStyle}>Domain</label>
            <input
                style={inputStyle}
                value={soul.domain ?? ''}
                onChange={e => update('domain', e.target.value || undefined)}
                placeholder='e.g. B2B SaaS pipeline management'
                disabled={disabled}
            />
            <label style={labelStyle}>Persona</label>
            <input
                style={inputStyle}
                value={soul.persona ?? ''}
                onChange={e => update('persona', e.target.value || undefined)}
                placeholder='e.g. concise, data-first, never speculative'
                disabled={disabled}
            />
            <label style={labelStyle}>Core values (one per line)</label>
            <textarea
                style={{ ...inputStyle, height: '52px', resize: 'vertical', fontFamily: 'inherit', fontSize: '0.82em' }}
                value={coreValuesText}
                onChange={e => {
                    setCoreValuesText(e.target.value);
                    const vals = e.target.value.split('\n').map(v => v.trim()).filter(Boolean);
                    update('coreValues', vals.length ? vals : undefined);
                }}
                placeholder={'accuracy over speed\nescalate uncertainty'}
                disabled={disabled}
            />
        </div>
    );
};

// -- Directives editor sub-component -------------------------------------

interface DirectivesEditorProps {
    agentId?: string;
    directives: AgentDirective[];
    onAdd: (text: string) => Promise<void>;
    onRemove: (id: string) => Promise<void>;
    onEdit: (id: string, text: string) => Promise<void>;
    onApprove?: (id: string) => Promise<void>;
    onReject?: (id: string) => Promise<void>;
    disabled?: boolean;
}

const DirectivesEditor: React.FC<DirectivesEditorProps> = ({
    directives, onAdd, onRemove, onEdit, onApprove, onReject, disabled,
}) => {
    const [newText, setNewText] = React.useState('');
    const [editingId, setEditingId] = React.useState<string | null>(null);
    const [editText, setEditText] = React.useState('');
    const [busy, setBusy] = React.useState(false);

    const active = directives.filter(d => d.status === 'active');
    const pending = directives.filter(d => d.status === 'pending');
    const rejected = directives.filter(d => d.status === 'rejected');

    const handleAdd = async () => {
        if (!newText.trim()) { return; }
        setBusy(true);
        try { await onAdd(newText.trim()); setNewText(''); }
        finally { setBusy(false); }
    };

    const handleSaveEdit = async (id: string) => {
        if (!editText.trim()) { return; }
        setBusy(true);
        try { await onEdit(id, editText.trim()); setEditingId(null); }
        finally { setBusy(false); }
    };

    const statusBadge = (d: AgentDirective) => {
        const color = d.status === 'active' ? 'var(--theia-charts-green)' :
            d.status === 'pending' ? 'var(--theia-charts-yellow)' : 'var(--theia-disabledForeground)';
        return (
            <span style={{
                fontSize: '0.65em', padding: '1px 5px', borderRadius: '8px',
                background: 'var(--theia-badge-background)', color: 'var(--theia-badge-foreground)',
                border: `1px solid ${color}`, flexShrink: 0,
            }}>
                {d.source === 'reflector' ? '✦ ' : ''}{d.status}
            </span>
        );
    };

    const renderDirective = (d: AgentDirective) => (
        <div key={d.id} style={{ display: 'flex', gap: '6px', padding: '3px 0', alignItems: 'flex-start' }}>
            {editingId === d.id ? (
                <>
                    <input
                        style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSaveEdit(d.id)}
                        disabled={busy}
                        autoFocus
                    />
                    <button className='theia-button' onClick={() => handleSaveEdit(d.id)} disabled={busy}
                        style={{ padding: '2px 6px', minWidth: 0, fontSize: '0.8em' }}>✓</button>
                    <button className='theia-button secondary' onClick={() => setEditingId(null)}
                        style={{ padding: '2px 6px', minWidth: 0, fontSize: '0.8em' }}>✕</button>
                </>
            ) : (
                <>
                    <span style={{ flex: 1, fontSize: '0.82em', paddingTop: '2px' }}>{d.text}</span>
                    {statusBadge(d)}
                    {d.status === 'pending' && onApprove && (
                        <button className='theia-button' title='Approve — activate this directive'
                            onClick={() => onApprove(d.id)} disabled={disabled || busy}
                            style={{ padding: '2px 6px', minWidth: 0, fontSize: '0.75em' }}>✓ Approve</button>
                    )}
                    {d.status === 'pending' && onReject && (
                        <button className='theia-button secondary' title='Reject this directive'
                            onClick={() => onReject(d.id)} disabled={disabled || busy}
                            style={{ padding: '2px 6px', minWidth: 0, fontSize: '0.75em' }}>✕ Reject</button>
                    )}
                    {d.status === 'active' && (
                        <button className='theia-button secondary' title='Edit directive'
                            onClick={() => { setEditingId(d.id); setEditText(d.text); }}
                            disabled={disabled || busy}
                            style={{ padding: '2px 5px', minWidth: 0 }}>
                            <span className={codicon('edit')} />
                        </button>
                    )}
                    <button className='theia-button secondary' title='Remove directive'
                        onClick={() => onRemove(d.id)} disabled={disabled || busy}
                        style={{ padding: '2px 5px', minWidth: 0 }}>
                        <span className={codicon('trash')} />
                    </button>
                </>
            )}
        </div>
    );

    return (
        <div style={{
            border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
            borderRadius: '4px',
            padding: '8px',
            marginBottom: '8px',
        }}>
            <div style={{ fontSize: '0.78em', fontWeight: 600, opacity: 0.7, marginBottom: '6px' }}>
                STANDING DIRECTIVES — injected between prompt and tool block
            </div>

            {active.length === 0 && pending.length === 0 && rejected.length === 0 && (
                <div style={{ fontSize: '0.78em', opacity: 0.5, marginBottom: '6px' }}>
                    No directives yet. Add one below or let the Reflector agent propose some after conversations.
                </div>
            )}

            {active.length > 0 && (
                <>
                    <div style={{ fontSize: '0.72em', opacity: 0.6, marginBottom: '3px' }}>Active</div>
                    {active.map(renderDirective)}
                </>
            )}
            {pending.length > 0 && (
                <>
                    <div style={{ fontSize: '0.72em', opacity: 0.6, marginTop: '6px', marginBottom: '3px' }}>
                        Pending review (proposed by Reflector)
                    </div>
                    {pending.map(renderDirective)}
                </>
            )}
            {rejected.length > 0 && (
                <>
                    <div style={{ fontSize: '0.72em', opacity: 0.4, marginTop: '6px', marginBottom: '3px' }}>Rejected</div>
                    {rejected.map(renderDirective)}
                </>
            )}

            <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
                <input
                    style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
                    value={newText}
                    onChange={e => setNewText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAdd()}
                    placeholder='Add directive (imperative rule, ≤ 20 words)…'
                    disabled={disabled || busy}
                />
                <button className='theia-button secondary' onClick={handleAdd} disabled={!newText.trim() || busy || !!disabled}
                    style={{ padding: '2px 8px', minWidth: 0, flexShrink: 0 }}>
                    <span className={codicon('add')} />
                </button>
            </div>
        </div>
    );
};

// -- Prompt history viewer -----------------------------------------------

interface PromptHistoryProps {
    agent: AgentDefinition;
    onRollback: (prompt: string) => void;
}

const PromptHistoryViewer: React.FC<PromptHistoryProps> = ({ agent, onRollback }) => {
    const [open, setOpen] = React.useState(false);
    const history = agent.promptHistory ?? [];
    if (history.length === 0) { return null; }

    return (
        <div style={{ marginBottom: '6px' }}>
            <button
                className='theia-button secondary'
                style={{ padding: '2px 8px', fontSize: '0.78em' }}
                onClick={() => setOpen(o => !o)}
            >
                <span className={codicon('history')} style={{ marginRight: '4px' }} />
                {open ? 'Hide' : 'Show'} prompt history ({history.length} snapshot{history.length !== 1 ? 's' : ''})
            </button>
            {open && (
                <div style={{
                    marginTop: '6px',
                    border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
                    borderRadius: '4px',
                    maxHeight: '200px',
                    overflowY: 'auto',
                    padding: '6px',
                    fontSize: '0.78em',
                }}>
                    {[...history].reverse().map(h => (
                        <div key={h.version} style={{ display: 'flex', gap: '8px', alignItems: 'center', padding: '3px 0', borderBottom: '1px solid var(--theia-editorWidget-border, transparent)' }}>
                            <span style={{ opacity: 0.7, flexShrink: 0 }}>v{h.version} — {h.changedAt.slice(0, 10)}</span>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.6 }}>
                                {h.prompt.slice(0, 80)}…
                            </span>
                            <button
                                className='theia-button secondary'
                                style={{ padding: '1px 6px', minWidth: 0, fontSize: '0.8em', flexShrink: 0 }}
                                onClick={() => onRollback(h.prompt)}
                                title='Restore this version into the prompt editor'
                            >Restore</button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Create / Edit form
// ---------------------------------------------------------------------------

interface AgentFormProps {
    initial?: AgentDefinition;
    model: AgentsModel;
    availableLlms: string[];
    availableSkills: SkillSummary[];
    availableTools: ToolDefinition[];
    onSubmit: (draft: AgentDraft) => Promise<void>;
    onCancel: () => void;
}

const DEFAULT_PROMPT = `# Role
You are [Name], [one sentence describing the role and context].

## Responsibilities
- [Key task 1]
- [Key task 2]

## Behaviour Principles
- **Tool-first**: Use available tools before answering from memory
- **Verify**: Check outputs before finalising
- **Escalate**: Surface uncertainty rather than guessing

## Current Context
{{contextDetails}}`;

const AgentForm: React.FC<AgentFormProps> = ({ initial, model, availableLlms, availableSkills, availableTools, onSubmit, onCancel }) => {
    const [name, setName] = React.useState(initial?.name ?? '');
    const [description, setDescription] = React.useState(initial?.description ?? '');
    const [prompt, setPrompt] = React.useState(initial?.prompt ?? DEFAULT_PROMPT);
    const [defaultLLM, setDefaultLLM] = React.useState(initial?.defaultLLM ?? (availableLlms[0] ?? 'gemini-2.5-flash'));
    const [skills, setSkills] = React.useState<string[]>(initial?.skills ?? []);
    const [tools, setTools] = React.useState<string[]>(initial?.tools ?? []);
    const [soul, setSoul] = React.useState<AgentSoul>(initial?.soul ?? {});
    const [directives, setDirectives] = React.useState<AgentDirective[]>(initial?.directives ?? []);
    const [showSoul, setShowSoul] = React.useState(!!(initial?.soul?.role || initial?.soul?.domain));
    const [showDirectives, setShowDirectives] = React.useState((initial?.directives?.length ?? 0) > 0);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>();

    const isEdit = !!initial;

    const toggleSkill = (skillName: string) => {
        setSkills(prev => prev.includes(skillName) ? prev.filter(s => s !== skillName) : [...prev, skillName]);
    };

    const toggleTool = (toolName: string) => {
        setTools(prev => prev.includes(toolName) ? prev.filter(t => t !== toolName) : [...prev, toolName]);
    };

    const handleSubmit = async () => {
        if (!name.trim()) { setError('Name is required.'); return; }
        if (!description.trim()) { setError('Description is required.'); return; }
        setError(undefined);
        setBusy(true);
        try {
            await onSubmit({
                name: name.trim(),
                description: description.trim(),
                prompt,
                defaultLLM,
                skills,
                tools,
                showInChat: true,
                soul: Object.keys(soul).length > 0 ? soul : undefined,
                directives,
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    // Directive handlers delegate to the model when editing an existing agent
    // (so changes are persisted immediately). For new agents, update local state.
    const handleAddDirective = async (text: string) => {
        if (isEdit && initial?.id) {
            const d = await model.addDirective(initial.id, text);
            setDirectives(prev => [...prev, d]);
        } else {
            const d: AgentDirective = {
                id: `d-local-${Date.now()}`,
                text,
                source: 'manual',
                addedAt: new Date().toISOString(),
                status: 'active',
            };
            setDirectives(prev => [...prev, d]);
        }
    };

    const handleRemoveDirective = async (id: string) => {
        if (isEdit && initial?.id) {
            await model.removeDirective(initial.id, id);
        }
        setDirectives(prev => prev.filter(d => d.id !== id));
    };

    const handleEditDirective = async (id: string, text: string) => {
        if (isEdit && initial?.id) {
            await model.updateDirective(initial.id, id, text);
        }
        setDirectives(prev => prev.map(d => d.id === id ? { ...d, text } : d));
    };

    const handleApproveDirective = async (id: string) => {
        if (isEdit && initial?.id) {
            await model.approveDirective(initial.id, id);
        }
        setDirectives(prev => prev.map(d => d.id === id ? { ...d, status: 'active' as const } : d));
    };

    const handleRejectDirective = async (id: string) => {
        if (isEdit && initial?.id) {
            await model.rejectDirective(initial.id, id);
        }
        setDirectives(prev => prev.map(d => d.id === id ? { ...d, status: 'rejected' as const } : d));
    };

    return (
        <div style={{
            background: 'var(--theia-editorWidget-background)',
            border: '1px solid var(--theia-editorWidget-border)',
            borderRadius: '6px',
            padding: '12px',
            marginTop: '8px',
        }}>
            <strong style={{ fontSize: '0.9em' }}>{isEdit ? `Edit ${initial.name}` : 'New Agent'}</strong>

            <label style={labelStyle}>Name</label>
            <input
                style={inputStyle}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder='e.g. Sales Follow-up'
                disabled={busy}
            />

            <label style={labelStyle}>Description</label>
            <input
                style={inputStyle}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder='One sentence describing what this agent does'
                disabled={busy}
            />

            <label style={labelStyle}>Default model</label>
            {availableLlms.length > 0 ? (
                <select
                    style={{ ...inputStyle, cursor: 'pointer' }}
                    value={defaultLLM}
                    onChange={e => setDefaultLLM(e.target.value)}
                    disabled={busy}
                >
                    {availableLlms.map(id => (
                        <option key={id} value={id}>{modelLabel(id)}</option>
                    ))}
                </select>
            ) : (
                <input style={inputStyle} value={defaultLLM} onChange={e => setDefaultLLM(e.target.value)} disabled={busy} />
            )}

            <label style={labelStyle}>System prompt</label>
            {isEdit && <PromptHistoryViewer agent={initial} onRollback={p => setPrompt(p)} />}
            <textarea
                style={{ ...inputStyle, height: '140px', resize: 'vertical', fontFamily: 'monospace', fontSize: '0.82em' }}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                disabled={busy}
            />

            {/* ---- Soul (collapsible) ----------------------------------- */}
            <div
                style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: '4px 0 2px', fontSize: '0.82em', opacity: 0.8 }}
                onClick={() => setShowSoul(s => !s)}
            >
                <span className={codicon(showSoul ? 'chevron-down' : 'chevron-right')} style={{ fontSize: '11px' }} />
                Soul — stable identity context
                {(soul.role || soul.domain) && <span style={{ fontSize: '0.85em', opacity: 0.6 }}>({soul.role ?? soul.domain})</span>}
            </div>
            {showSoul && <SoulEditor soul={soul} onChange={setSoul} disabled={busy} />}

            {/* ---- Directives (collapsible) ----------------------------- */}
            <div
                style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: '4px 0 2px', fontSize: '0.82em', opacity: 0.8 }}
                onClick={() => setShowDirectives(s => !s)}
            >
                <span className={codicon(showDirectives ? 'chevron-down' : 'chevron-right')} style={{ fontSize: '11px' }} />
                Standing Directives
                {directives.filter(d => d.status === 'active').length > 0 && (
                    <span style={{ fontSize: '0.85em', opacity: 0.6 }}>
                        ({directives.filter(d => d.status === 'active').length} active
                        {directives.filter(d => d.status === 'pending').length > 0
                            ? `, ${directives.filter(d => d.status === 'pending').length} pending review` : ''})
                    </span>
                )}
            </div>
            {showDirectives && (
                <DirectivesEditor
                    agentId={initial?.id}
                    directives={directives}
                    onAdd={handleAddDirective}
                    onRemove={handleRemoveDirective}
                    onEdit={handleEditDirective}
                    onApprove={handleApproveDirective}
                    onReject={handleRejectDirective}
                    disabled={busy}
                />
            )}

            {/* ---- Skills ----------------------------------------------- */}
            <label style={labelStyle}>Skills</label>
            {availableSkills.length === 0 ? (
                <div style={{ fontSize: '0.78em', opacity: 0.55, marginBottom: '6px' }}>
                    No skills found. Add SKILL.md files under the workspace <code>skills/</code> folder.
                </div>
            ) : (
                <div style={{
                    maxHeight: '160px',
                    overflowY: 'auto',
                    border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
                    borderRadius: '4px',
                    padding: '4px 6px',
                    marginBottom: '6px',
                }}>
                    {availableSkills.map(skill => (
                        <label
                            key={skill.name}
                            style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '3px 0', cursor: 'pointer' }}
                            title={skill.whenToUse ?? skill.description}
                        >
                            <input
                                type='checkbox'
                                checked={skills.includes(skill.name)}
                                onChange={() => toggleSkill(skill.name)}
                                disabled={busy}
                                style={{ marginTop: '2px', flexShrink: 0 }}
                            />
                            <span style={{ minWidth: 0 }}>
                                <span style={{ fontSize: '0.85em', fontWeight: 500 }}>
                                    {skill.domain ? `${skill.domain} / ` : ''}{skill.name}
                                </span>
                                {skill.safety && !skill.safety.ok && (
                                    <span
                                        title={skill.safety.findings.map(f => `[${f.severity}] ${f.message}` + (f.line ? ` (line ${f.line})` : '')).join('\n')}
                                        style={{
                                            marginLeft: '5px',
                                            fontSize: '0.66em',
                                            padding: '0 5px',
                                            borderRadius: '8px',
                                            border: '1px solid var(--theia-editorError-foreground, #e51400)',
                                            color: 'var(--theia-editorError-foreground, #e51400)',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        ⚠ unsafe ({skill.safety.score}/100)
                                    </span>
                                )}
                                {skill.safety && skill.safety.ok && skill.safety.findings.length > 0 && (
                                    <span
                                        title={skill.safety.findings.map(f => `[${f.severity}] ${f.message}` + (f.line ? ` (line ${f.line})` : '')).join('\n')}
                                        style={{
                                            marginLeft: '5px',
                                            fontSize: '0.66em',
                                            padding: '0 5px',
                                            borderRadius: '8px',
                                            border: '1px solid var(--theia-editorWarning-foreground, #bf8803)',
                                            color: 'var(--theia-editorWarning-foreground, #bf8803)',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        review
                                    </span>
                                )}
                                <span style={{ display: 'block', fontSize: '0.74em', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {skill.description}
                                </span>
                            </span>
                        </label>
                    ))}
                </div>
            )}

            {/* ---- Tools ------------------------------------------------ */}
            <label style={labelStyle}>Tools</label>
            {availableTools.length === 0 ? (
                <div style={{ fontSize: '0.78em', opacity: 0.55, marginBottom: '6px' }}>
                    No tools yet. Create integration tools in the <strong>Tools</strong> sidebar (or ask the
                    Agent Creator to set them up), then grant them here.
                </div>
            ) : (
                <div style={{
                    maxHeight: '160px',
                    overflowY: 'auto',
                    border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
                    borderRadius: '4px',
                    padding: '4px 6px',
                    marginBottom: '6px',
                }}>
                    {availableTools.map(tool => (
                        <label
                            key={tool.id}
                            style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '3px 0', cursor: 'pointer' }}
                            title={tool.description}
                        >
                            <input
                                type='checkbox'
                                checked={tools.includes(tool.name)}
                                onChange={() => toggleTool(tool.name)}
                                disabled={busy}
                                style={{ marginTop: '2px', flexShrink: 0 }}
                            />
                            <span style={{ minWidth: 0 }}>
                                <span style={{ fontSize: '0.85em', fontWeight: 500 }}>
                                    {tool.name}
                                    <span style={{
                                        marginLeft: '5px',
                                        fontSize: '0.66em',
                                        padding: '0 5px',
                                        borderRadius: '8px',
                                        border: '1px solid var(--theia-editorWidget-border, #888)',
                                        opacity: 0.8,
                                        whiteSpace: 'nowrap',
                                    }}>{tool.method}</span>
                                    {tool.enabled === false && (
                                        <span style={{ marginLeft: '5px', fontSize: '0.66em', opacity: 0.6 }}>(disabled)</span>
                                    )}
                                </span>
                                <span style={{ display: 'block', fontSize: '0.74em', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {tool.description}
                                </span>
                            </span>
                        </label>
                    ))}
                </div>
            )}

            {error && (
                <div style={{ color: 'var(--theia-errorForeground)', fontSize: '0.82em', marginBottom: '6px' }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '4px' }}>
                <button className='theia-button secondary' onClick={onCancel} disabled={busy}>Cancel</button>
                <button className='theia-button' onClick={handleSubmit} disabled={busy}>
                    {busy ? 'Saving…' : (isEdit ? 'Save' : 'Create')}
                </button>
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Main panel view (React FC with hooks — wraps the ReactWidget render())
// ---------------------------------------------------------------------------

interface AgentsPanelViewProps {
    model: AgentsModel;
}

type FormState = { mode: 'create' } | { mode: 'edit'; agent: AgentDefinition } | null;

const AgentsPanelView: React.FC<AgentsPanelViewProps> = ({ model }) => {
    // Keep React in sync with model changes
    const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => {
        const handle = model.onDidChange(() => forceUpdate());
        return () => handle.dispose();
    }, [model]);

    const [formState, setFormState] = React.useState<FormState>(null);
    const [deleteConfirm, setDeleteConfirm] = React.useState<string | null>(null);
    const [reflectingId, setReflectingId] = React.useState<string | null>(null);

    const handleSwitchAgent = async (id: string) => {
        await model.switchToAgent(id);
    };

    const handleCreate = async (draft: AgentDraft) => {
        await model.createAgent(draft);
        setFormState(null);
    };

    const handleEdit = async (draft: AgentDraft) => {
        if (formState?.mode === 'edit') {
            await model.updateAgent(formState.agent.id, draft);
        }
        setFormState(null);
    };

    const handleDelete = async (agent: AgentDefinition) => {
        if (deleteConfirm === agent.id) {
            await model.deleteAgent(agent.id);
            setDeleteConfirm(null);
        } else {
            setDeleteConfirm(agent.id);
        }
    };

    // Switch to the Reflector agent and set context via the default agent pref
    const handleReflect = async (agentId: string) => {
        setReflectingId(agentId);
        await model.switchToAgent('reflector');
        setReflectingId(null);
    };

    const availableLlms = model.availableLlms;
    const activeAgentId = model.activeAgentId;

    // Collect all pending directives across agents for the top banner
    const pendingCount = model.agents.reduce(
        (n, a) => n + (a.directives ?? []).filter(d => d.status === 'pending').length, 0
    );

    return (
        <div style={panelStyle}>
            {/* ---- Header ----------------------------------------------- */}
            <div style={{ marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <span className={codicon('hubot')} style={{ opacity: 0.8 }} />
                    <strong style={{ flex: 1, fontSize: '0.95em' }}>Agents</strong>
                    <button
                        className='theia-button secondary'
                        title='Refresh agent list'
                        onClick={model.refresh}
                        disabled={model.loading}
                        style={{ padding: '2px 8px', minWidth: 0 }}
                    >
                        <span className={codicon(model.loading ? 'sync~spin' : 'refresh')} />
                    </button>
                </div>
            </div>

            {/* ---- Pending directives banner ----------------------------- */}
            {pendingCount > 0 && (
                <div style={{
                    background: 'var(--theia-inputValidation-warningBackground)',
                    border: '1px solid var(--theia-inputValidation-warningBorder)',
                    borderRadius: '4px',
                    padding: '6px 10px',
                    fontSize: '0.78em',
                    marginBottom: '6px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                }}>
                    <span className={codicon('lightbulb')} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>
                        {pendingCount} directive{pendingCount !== 1 ? 's' : ''} pending review — open an agent to approve or reject.
                    </span>
                </div>
            )}

            {/* ---- Error banner ----------------------------------------- */}
            {model.error && (
                <div style={{ color: 'var(--theia-errorForeground)', fontSize: '0.82em', margin: '4px 0' }}>
                    {model.error}
                </div>
            )}

            {/* ---- Agent list ------------------------------------------- */}
            <div style={sectionTitleStyle}>Available Agents</div>

            {model.agents.length === 0 && !model.loading && (
                <div style={{ opacity: 0.55, fontSize: '0.85em' }}>No agents found. Create one below.</div>
            )}

            {model.agents.map(agent => (
                <div key={agent.id}>
                    <AgentRow
                        agent={agent}
                        isActive={agent.id === activeAgentId}
                        trust={model.trustScores[agent.id]}
                        onSwitch={() => handleSwitchAgent(agent.id)}
                        onDelete={() => handleDelete(agent)}
                        onEdit={() => setFormState(formState?.mode === 'edit' && formState.agent.id === agent.id ? null : { mode: 'edit', agent })}
                    />
                    {/* Reflect button — only for non-reflector, visible agents */}
                    {agent.id !== 'reflector' && !agent.builtin && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '2px' }}>
                            <button
                                className='theia-button secondary'
                                title='Switch to Reflector agent and analyse feedback for this agent'
                                onClick={() => handleReflect(agent.id)}
                                disabled={reflectingId !== null}
                                style={{ padding: '1px 7px', fontSize: '0.72em', minWidth: 0 }}
                            >
                                {reflectingId === agent.id
                                    ? <span className={codicon('sync~spin')} />
                                    : <><span className={codicon('sparkle')} style={{ marginRight: '3px' }} />Reflect…</>
                                }
                            </button>
                        </div>
                    )}
                    {deleteConfirm === agent.id && (
                        <div style={{
                            background: 'var(--theia-inputValidation-warningBackground)',
                            border: '1px solid var(--theia-inputValidation-warningBorder)',
                            borderRadius: '4px',
                            padding: '6px 10px',
                            fontSize: '0.82em',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            marginBottom: '4px',
                        }}>
                            <span style={{ flex: 1 }}>Delete <strong>{agent.name}</strong>? This cannot be undone.</span>
                            <button className='theia-button' onClick={() => handleDelete(agent)} style={{ padding: '2px 8px' }}>Delete</button>
                            <button className='theia-button secondary' onClick={() => setDeleteConfirm(null)} style={{ padding: '2px 8px' }}>Cancel</button>
                        </div>
                    )}
                    {formState?.mode === 'edit' && formState.agent.id === agent.id && (
                        <AgentForm
                            initial={agent}
                            model={model}
                            availableLlms={availableLlms}
                            availableSkills={model.availableSkills}
                            availableTools={model.availableTools}
                            onSubmit={handleEdit}
                            onCancel={() => setFormState(null)}
                        />
                    )}
                </div>
            ))}

            {/* ---- Create form ------------------------------------------ */}
            <div style={{ marginTop: '8px' }}>
                {formState?.mode !== 'create' ? (
                    <button
                        className='theia-button secondary'
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}
                        onClick={() => setFormState({ mode: 'create' })}
                    >
                        <span className={codicon('add')} />
                        New Agent
                    </button>
                ) : (
                    <AgentForm
                        model={model}
                        availableLlms={availableLlms}
                        availableSkills={model.availableSkills}
                        availableTools={model.availableTools}
                        onSubmit={handleCreate}
                        onCancel={() => setFormState(null)}
                    />
                )}
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// ReactWidget shell
// ---------------------------------------------------------------------------

/**
 * Side-bar widget that shows the list of Command Center agents, an LLM selector, and
 * a create / edit / delete form.
 */
@injectable()
export class AgentsPanelWidget extends ReactWidget {

    static readonly ID = AGENTS_PANEL_ID;
    static readonly LABEL = 'Agents';

    @inject(AgentsModel)
    protected readonly model: AgentsModel;

    @postConstruct()
    protected init(): void {
        this.id = AgentsPanelWidget.ID;
        this.title.label = AgentsPanelWidget.LABEL;
        this.title.caption = 'Command Center Agents';
        this.title.iconClass = codicon('robot');
        this.toDispose.push(this.model.onDidChange(() => this.update()));
        this.update();
    }

    protected render(): React.ReactNode {
        return <AgentsPanelView model={this.model} />;
    }
}
