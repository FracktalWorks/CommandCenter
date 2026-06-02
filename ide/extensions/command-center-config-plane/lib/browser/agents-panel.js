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
var AgentsPanelWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentsPanelWidget = exports.AGENTS_PANEL_ID = void 0;
const React = __importStar(require("@theia/core/shared/react"));
const inversify_1 = require("@theia/core/shared/inversify");
const react_widget_1 = require("@theia/core/lib/browser/widgets/react-widget");
const browser_1 = require("@theia/core/lib/browser");
const agents_model_1 = require("./agents-model");
exports.AGENTS_PANEL_ID = 'commandCenter.agents-panel';
// ---------------------------------------------------------------------------
// Helpers
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
const labelStyle = {
    display: 'block',
    fontSize: '0.82em',
    opacity: 0.85,
    margin: '6px 0 3px',
};
/** Human-readable label for a model ID. */
function modelLabel(id) {
    return id
        .replace('gemini-', 'Gemini ')
        .replace('-flash-preview', ' Flash Preview')
        .replace('-flash', ' Flash')
        .replace('-pro-preview', ' Pro Preview')
        .replace('-pro', ' Pro');
}
/** Map a trust band to a theme colour token. */
const TRUST_COLORS = {
    unrated: 'var(--theia-descriptionForeground)',
    poor: 'var(--theia-editorError-foreground, #e51400)',
    fair: 'var(--theia-editorWarning-foreground, #bf8803)',
    good: 'var(--theia-charts-green, #388a34)',
    excellent: 'var(--theia-charts-green, #388a34)',
};
/** Small pill showing an agent's recency-weighted trust score. */
const TrustBadge = ({ trust }) => {
    const label = trust.band === 'unrated'
        ? 'unrated'
        : `${trust.score}% trust`;
    const tip = trust.total === 0
        ? 'No feedback yet — rate responses with 👍/👎 in chat to build a trust score.'
        : `Trust ${trust.score}/100 (${trust.band}) from ${trust.total} rating${trust.total === 1 ? '' : 's'}: ${trust.positive}👍 / ${trust.negative}👎`;
    return (React.createElement("span", { title: tip, style: {
            fontSize: '0.66em',
            padding: '0 5px',
            borderRadius: '8px',
            border: `1px solid ${TRUST_COLORS[trust.band]}`,
            color: TRUST_COLORS[trust.band],
            whiteSpace: 'nowrap',
        } }, label));
};
const AgentRow = ({ agent, isActive, trust, onSwitch, onDelete, onEdit }) => (React.createElement("div", { onClick: onSwitch, style: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '8px 10px',
        borderRadius: '6px',
        cursor: 'pointer',
        background: isActive ? 'var(--theia-list-activeSelectionBackground)' : 'transparent',
        color: isActive ? 'var(--theia-list-activeSelectionForeground)' : 'inherit',
        marginBottom: '2px',
    }, title: isActive ? `${agent.name} — active` : `Switch to ${agent.name}` },
    React.createElement("span", { className: (0, browser_1.codicon)(agent.id === 'agent-creator' ? 'beaker' : 'robot'), style: { marginTop: '1px', opacity: 0.8, flexShrink: 0 } }),
    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            React.createElement("span", { style: { fontWeight: 500, fontSize: '0.92em' } }, agent.name),
            isActive && (React.createElement("span", { className: (0, browser_1.codicon)('check'), style: { fontSize: '0.8em', opacity: 0.8 } })),
            agent.builtin && (React.createElement("span", { style: {
                    fontSize: '0.68em',
                    padding: '0 5px',
                    borderRadius: '8px',
                    background: 'var(--theia-badge-background)',
                    color: 'var(--theia-badge-foreground)',
                } }, "built-in")),
            trust && React.createElement(TrustBadge, { trust: trust })),
        React.createElement("div", { style: { fontSize: '0.78em', opacity: 0.65, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, agent.description),
        React.createElement("div", { style: { fontSize: '0.72em', opacity: 0.5, marginTop: '2px' } }, agent.defaultLLM)),
    React.createElement("div", { style: { display: 'flex', gap: '2px', flexShrink: 0 }, onClick: e => e.stopPropagation() },
        React.createElement("button", { className: 'theia-button secondary', title: 'Edit agent', onClick: onEdit, style: { padding: '2px 5px', minWidth: 0 } },
            React.createElement("span", { className: (0, browser_1.codicon)('edit') })),
        React.createElement("button", { className: 'theia-button secondary', title: agent.builtin ? 'Built-in agents cannot be deleted' : 'Delete agent', onClick: onDelete, disabled: !!agent.builtin, style: { padding: '2px 5px', minWidth: 0 } },
            React.createElement("span", { className: (0, browser_1.codicon)('trash') })))));
const SoulEditor = ({ soul, onChange, disabled }) => {
    var _a, _b, _c, _d;
    const update = (key, value) => onChange({ ...soul, [key]: value });
    const [coreValuesText, setCoreValuesText] = React.useState(((_a = soul.coreValues) !== null && _a !== void 0 ? _a : []).join('\n'));
    return (React.createElement("div", { style: {
            border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
            borderRadius: '4px',
            padding: '8px',
            marginBottom: '8px',
        } },
        React.createElement("div", { style: { fontSize: '0.78em', fontWeight: 600, opacity: 0.7, marginBottom: '6px' } }, "SOUL \u2014 stable identity context compiled into the prompt"),
        React.createElement("label", { style: labelStyle }, "Role title"),
        React.createElement("input", { style: inputStyle, value: (_b = soul.role) !== null && _b !== void 0 ? _b : '', onChange: e => update('role', e.target.value || undefined), placeholder: 'e.g. Sales Intelligence Agent', disabled: disabled }),
        React.createElement("label", { style: labelStyle }, "Domain"),
        React.createElement("input", { style: inputStyle, value: (_c = soul.domain) !== null && _c !== void 0 ? _c : '', onChange: e => update('domain', e.target.value || undefined), placeholder: 'e.g. B2B SaaS pipeline management', disabled: disabled }),
        React.createElement("label", { style: labelStyle }, "Persona"),
        React.createElement("input", { style: inputStyle, value: (_d = soul.persona) !== null && _d !== void 0 ? _d : '', onChange: e => update('persona', e.target.value || undefined), placeholder: 'e.g. concise, data-first, never speculative', disabled: disabled }),
        React.createElement("label", { style: labelStyle }, "Core values (one per line)"),
        React.createElement("textarea", { style: { ...inputStyle, height: '52px', resize: 'vertical', fontFamily: 'inherit', fontSize: '0.82em' }, value: coreValuesText, onChange: e => {
                setCoreValuesText(e.target.value);
                const vals = e.target.value.split('\n').map(v => v.trim()).filter(Boolean);
                update('coreValues', vals.length ? vals : undefined);
            }, placeholder: 'accuracy over speed\nescalate uncertainty', disabled: disabled })));
};
const DirectivesEditor = ({ directives, onAdd, onRemove, onEdit, onApprove, onReject, disabled, }) => {
    const [newText, setNewText] = React.useState('');
    const [editingId, setEditingId] = React.useState(null);
    const [editText, setEditText] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const active = directives.filter(d => d.status === 'active');
    const pending = directives.filter(d => d.status === 'pending');
    const rejected = directives.filter(d => d.status === 'rejected');
    const handleAdd = async () => {
        if (!newText.trim()) {
            return;
        }
        setBusy(true);
        try {
            await onAdd(newText.trim());
            setNewText('');
        }
        finally {
            setBusy(false);
        }
    };
    const handleSaveEdit = async (id) => {
        if (!editText.trim()) {
            return;
        }
        setBusy(true);
        try {
            await onEdit(id, editText.trim());
            setEditingId(null);
        }
        finally {
            setBusy(false);
        }
    };
    const statusBadge = (d) => {
        const color = d.status === 'active' ? 'var(--theia-charts-green)' :
            d.status === 'pending' ? 'var(--theia-charts-yellow)' : 'var(--theia-disabledForeground)';
        return (React.createElement("span", { style: {
                fontSize: '0.65em', padding: '1px 5px', borderRadius: '8px',
                background: 'var(--theia-badge-background)', color: 'var(--theia-badge-foreground)',
                border: `1px solid ${color}`, flexShrink: 0,
            } },
            d.source === 'reflector' ? '✦ ' : '',
            d.status));
    };
    const renderDirective = (d) => (React.createElement("div", { key: d.id, style: { display: 'flex', gap: '6px', padding: '3px 0', alignItems: 'flex-start' } }, editingId === d.id ? (React.createElement(React.Fragment, null,
        React.createElement("input", { style: { ...inputStyle, flex: 1, marginBottom: 0 }, value: editText, onChange: e => setEditText(e.target.value), onKeyDown: e => e.key === 'Enter' && handleSaveEdit(d.id), disabled: busy, autoFocus: true }),
        React.createElement("button", { className: 'theia-button', onClick: () => handleSaveEdit(d.id), disabled: busy, style: { padding: '2px 6px', minWidth: 0, fontSize: '0.8em' } }, "\u2713"),
        React.createElement("button", { className: 'theia-button secondary', onClick: () => setEditingId(null), style: { padding: '2px 6px', minWidth: 0, fontSize: '0.8em' } }, "\u2715"))) : (React.createElement(React.Fragment, null,
        React.createElement("span", { style: { flex: 1, fontSize: '0.82em', paddingTop: '2px' } }, d.text),
        statusBadge(d),
        d.status === 'pending' && onApprove && (React.createElement("button", { className: 'theia-button', title: 'Approve \u2014 activate this directive', onClick: () => onApprove(d.id), disabled: disabled || busy, style: { padding: '2px 6px', minWidth: 0, fontSize: '0.75em' } }, "\u2713 Approve")),
        d.status === 'pending' && onReject && (React.createElement("button", { className: 'theia-button secondary', title: 'Reject this directive', onClick: () => onReject(d.id), disabled: disabled || busy, style: { padding: '2px 6px', minWidth: 0, fontSize: '0.75em' } }, "\u2715 Reject")),
        d.status === 'active' && (React.createElement("button", { className: 'theia-button secondary', title: 'Edit directive', onClick: () => { setEditingId(d.id); setEditText(d.text); }, disabled: disabled || busy, style: { padding: '2px 5px', minWidth: 0 } },
            React.createElement("span", { className: (0, browser_1.codicon)('edit') }))),
        React.createElement("button", { className: 'theia-button secondary', title: 'Remove directive', onClick: () => onRemove(d.id), disabled: disabled || busy, style: { padding: '2px 5px', minWidth: 0 } },
            React.createElement("span", { className: (0, browser_1.codicon)('trash') }))))));
    return (React.createElement("div", { style: {
            border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
            borderRadius: '4px',
            padding: '8px',
            marginBottom: '8px',
        } },
        React.createElement("div", { style: { fontSize: '0.78em', fontWeight: 600, opacity: 0.7, marginBottom: '6px' } }, "STANDING DIRECTIVES \u2014 injected between prompt and tool block"),
        active.length === 0 && pending.length === 0 && rejected.length === 0 && (React.createElement("div", { style: { fontSize: '0.78em', opacity: 0.5, marginBottom: '6px' } }, "No directives yet. Add one below or let the Reflector agent propose some after conversations.")),
        active.length > 0 && (React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: '0.72em', opacity: 0.6, marginBottom: '3px' } }, "Active"),
            active.map(renderDirective))),
        pending.length > 0 && (React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: '0.72em', opacity: 0.6, marginTop: '6px', marginBottom: '3px' } }, "Pending review (proposed by Reflector)"),
            pending.map(renderDirective))),
        rejected.length > 0 && (React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: '0.72em', opacity: 0.4, marginTop: '6px', marginBottom: '3px' } }, "Rejected"),
            rejected.map(renderDirective))),
        React.createElement("div", { style: { display: 'flex', gap: '4px', marginTop: '8px' } },
            React.createElement("input", { style: { ...inputStyle, flex: 1, marginBottom: 0 }, value: newText, onChange: e => setNewText(e.target.value), onKeyDown: e => e.key === 'Enter' && handleAdd(), placeholder: 'Add directive (imperative rule, \u2264 20 words)\u2026', disabled: disabled || busy }),
            React.createElement("button", { className: 'theia-button secondary', onClick: handleAdd, disabled: !newText.trim() || busy || !!disabled, style: { padding: '2px 8px', minWidth: 0, flexShrink: 0 } },
                React.createElement("span", { className: (0, browser_1.codicon)('add') })))));
};
const PromptHistoryViewer = ({ agent, onRollback }) => {
    var _a;
    const [open, setOpen] = React.useState(false);
    const history = (_a = agent.promptHistory) !== null && _a !== void 0 ? _a : [];
    if (history.length === 0) {
        return null;
    }
    return (React.createElement("div", { style: { marginBottom: '6px' } },
        React.createElement("button", { className: 'theia-button secondary', style: { padding: '2px 8px', fontSize: '0.78em' }, onClick: () => setOpen(o => !o) },
            React.createElement("span", { className: (0, browser_1.codicon)('history'), style: { marginRight: '4px' } }),
            open ? 'Hide' : 'Show',
            " prompt history (",
            history.length,
            " snapshot",
            history.length !== 1 ? 's' : '',
            ")"),
        open && (React.createElement("div", { style: {
                marginTop: '6px',
                border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
                borderRadius: '4px',
                maxHeight: '200px',
                overflowY: 'auto',
                padding: '6px',
                fontSize: '0.78em',
            } }, [...history].reverse().map(h => (React.createElement("div", { key: h.version, style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '3px 0', borderBottom: '1px solid var(--theia-editorWidget-border, transparent)' } },
            React.createElement("span", { style: { opacity: 0.7, flexShrink: 0 } },
                "v",
                h.version,
                " \u2014 ",
                h.changedAt.slice(0, 10)),
            React.createElement("span", { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.6 } },
                h.prompt.slice(0, 80),
                "\u2026"),
            React.createElement("button", { className: 'theia-button secondary', style: { padding: '1px 6px', minWidth: 0, fontSize: '0.8em', flexShrink: 0 }, onClick: () => onRollback(h.prompt), title: 'Restore this version into the prompt editor' }, "Restore"))))))));
};
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
const AgentForm = ({ initial, model, availableLlms, availableSkills, availableTools, onSubmit, onCancel }) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
    const [name, setName] = React.useState((_a = initial === null || initial === void 0 ? void 0 : initial.name) !== null && _a !== void 0 ? _a : '');
    const [description, setDescription] = React.useState((_b = initial === null || initial === void 0 ? void 0 : initial.description) !== null && _b !== void 0 ? _b : '');
    const [prompt, setPrompt] = React.useState((_c = initial === null || initial === void 0 ? void 0 : initial.prompt) !== null && _c !== void 0 ? _c : DEFAULT_PROMPT);
    const [defaultLLM, setDefaultLLM] = React.useState((_d = initial === null || initial === void 0 ? void 0 : initial.defaultLLM) !== null && _d !== void 0 ? _d : ((_e = availableLlms[0]) !== null && _e !== void 0 ? _e : 'gemini-2.5-flash'));
    const [skills, setSkills] = React.useState((_f = initial === null || initial === void 0 ? void 0 : initial.skills) !== null && _f !== void 0 ? _f : []);
    const [tools, setTools] = React.useState((_g = initial === null || initial === void 0 ? void 0 : initial.tools) !== null && _g !== void 0 ? _g : []);
    const [soul, setSoul] = React.useState((_h = initial === null || initial === void 0 ? void 0 : initial.soul) !== null && _h !== void 0 ? _h : {});
    const [directives, setDirectives] = React.useState((_j = initial === null || initial === void 0 ? void 0 : initial.directives) !== null && _j !== void 0 ? _j : []);
    const [showSoul, setShowSoul] = React.useState(!!(((_k = initial === null || initial === void 0 ? void 0 : initial.soul) === null || _k === void 0 ? void 0 : _k.role) || ((_l = initial === null || initial === void 0 ? void 0 : initial.soul) === null || _l === void 0 ? void 0 : _l.domain)));
    const [showDirectives, setShowDirectives] = React.useState(((_o = (_m = initial === null || initial === void 0 ? void 0 : initial.directives) === null || _m === void 0 ? void 0 : _m.length) !== null && _o !== void 0 ? _o : 0) > 0);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState();
    const isEdit = !!initial;
    const toggleSkill = (skillName) => {
        setSkills(prev => prev.includes(skillName) ? prev.filter(s => s !== skillName) : [...prev, skillName]);
    };
    const toggleTool = (toolName) => {
        setTools(prev => prev.includes(toolName) ? prev.filter(t => t !== toolName) : [...prev, toolName]);
    };
    const handleSubmit = async () => {
        if (!name.trim()) {
            setError('Name is required.');
            return;
        }
        if (!description.trim()) {
            setError('Description is required.');
            return;
        }
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
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    };
    // Directive handlers delegate to the model when editing an existing agent
    // (so changes are persisted immediately). For new agents, update local state.
    const handleAddDirective = async (text) => {
        if (isEdit && (initial === null || initial === void 0 ? void 0 : initial.id)) {
            const d = await model.addDirective(initial.id, text);
            setDirectives(prev => [...prev, d]);
        }
        else {
            const d = {
                id: `d-local-${Date.now()}`,
                text,
                source: 'manual',
                addedAt: new Date().toISOString(),
                status: 'active',
            };
            setDirectives(prev => [...prev, d]);
        }
    };
    const handleRemoveDirective = async (id) => {
        if (isEdit && (initial === null || initial === void 0 ? void 0 : initial.id)) {
            await model.removeDirective(initial.id, id);
        }
        setDirectives(prev => prev.filter(d => d.id !== id));
    };
    const handleEditDirective = async (id, text) => {
        if (isEdit && (initial === null || initial === void 0 ? void 0 : initial.id)) {
            await model.updateDirective(initial.id, id, text);
        }
        setDirectives(prev => prev.map(d => d.id === id ? { ...d, text } : d));
    };
    const handleApproveDirective = async (id) => {
        if (isEdit && (initial === null || initial === void 0 ? void 0 : initial.id)) {
            await model.approveDirective(initial.id, id);
        }
        setDirectives(prev => prev.map(d => d.id === id ? { ...d, status: 'active' } : d));
    };
    const handleRejectDirective = async (id) => {
        if (isEdit && (initial === null || initial === void 0 ? void 0 : initial.id)) {
            await model.rejectDirective(initial.id, id);
        }
        setDirectives(prev => prev.map(d => d.id === id ? { ...d, status: 'rejected' } : d));
    };
    return (React.createElement("div", { style: {
            background: 'var(--theia-editorWidget-background)',
            border: '1px solid var(--theia-editorWidget-border)',
            borderRadius: '6px',
            padding: '12px',
            marginTop: '8px',
        } },
        React.createElement("strong", { style: { fontSize: '0.9em' } }, isEdit ? `Edit ${initial.name}` : 'New Agent'),
        React.createElement("label", { style: labelStyle }, "Name"),
        React.createElement("input", { style: inputStyle, value: name, onChange: e => setName(e.target.value), placeholder: 'e.g. Sales Follow-up', disabled: busy }),
        React.createElement("label", { style: labelStyle }, "Description"),
        React.createElement("input", { style: inputStyle, value: description, onChange: e => setDescription(e.target.value), placeholder: 'One sentence describing what this agent does', disabled: busy }),
        React.createElement("label", { style: labelStyle }, "Default model"),
        availableLlms.length > 0 ? (React.createElement("select", { style: { ...inputStyle, cursor: 'pointer' }, value: defaultLLM, onChange: e => setDefaultLLM(e.target.value), disabled: busy }, availableLlms.map(id => (React.createElement("option", { key: id, value: id }, modelLabel(id)))))) : (React.createElement("input", { style: inputStyle, value: defaultLLM, onChange: e => setDefaultLLM(e.target.value), disabled: busy })),
        React.createElement("label", { style: labelStyle }, "System prompt"),
        isEdit && React.createElement(PromptHistoryViewer, { agent: initial, onRollback: p => setPrompt(p) }),
        React.createElement("textarea", { style: { ...inputStyle, height: '140px', resize: 'vertical', fontFamily: 'monospace', fontSize: '0.82em' }, value: prompt, onChange: e => setPrompt(e.target.value), disabled: busy }),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: '4px 0 2px', fontSize: '0.82em', opacity: 0.8 }, onClick: () => setShowSoul(s => !s) },
            React.createElement("span", { className: (0, browser_1.codicon)(showSoul ? 'chevron-down' : 'chevron-right'), style: { fontSize: '11px' } }),
            "Soul \u2014 stable identity context",
            (soul.role || soul.domain) && React.createElement("span", { style: { fontSize: '0.85em', opacity: 0.6 } },
                "(", (_p = soul.role) !== null && _p !== void 0 ? _p : soul.domain,
                ")")),
        showSoul && React.createElement(SoulEditor, { soul: soul, onChange: setSoul, disabled: busy }),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: '4px 0 2px', fontSize: '0.82em', opacity: 0.8 }, onClick: () => setShowDirectives(s => !s) },
            React.createElement("span", { className: (0, browser_1.codicon)(showDirectives ? 'chevron-down' : 'chevron-right'), style: { fontSize: '11px' } }),
            "Standing Directives",
            directives.filter(d => d.status === 'active').length > 0 && (React.createElement("span", { style: { fontSize: '0.85em', opacity: 0.6 } },
                "(",
                directives.filter(d => d.status === 'active').length,
                " active",
                directives.filter(d => d.status === 'pending').length > 0
                    ? `, ${directives.filter(d => d.status === 'pending').length} pending review` : '',
                ")"))),
        showDirectives && (React.createElement(DirectivesEditor, { agentId: initial === null || initial === void 0 ? void 0 : initial.id, directives: directives, onAdd: handleAddDirective, onRemove: handleRemoveDirective, onEdit: handleEditDirective, onApprove: handleApproveDirective, onReject: handleRejectDirective, disabled: busy })),
        React.createElement("label", { style: labelStyle }, "Skills"),
        availableSkills.length === 0 ? (React.createElement("div", { style: { fontSize: '0.78em', opacity: 0.55, marginBottom: '6px' } },
            "No skills found. Add SKILL.md files under the workspace ",
            React.createElement("code", null, "skills/"),
            " folder.")) : (React.createElement("div", { style: {
                maxHeight: '160px',
                overflowY: 'auto',
                border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
                borderRadius: '4px',
                padding: '4px 6px',
                marginBottom: '6px',
            } }, availableSkills.map(skill => {
            var _a;
            return (React.createElement("label", { key: skill.name, style: { display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '3px 0', cursor: 'pointer' }, title: (_a = skill.whenToUse) !== null && _a !== void 0 ? _a : skill.description },
                React.createElement("input", { type: 'checkbox', checked: skills.includes(skill.name), onChange: () => toggleSkill(skill.name), disabled: busy, style: { marginTop: '2px', flexShrink: 0 } }),
                React.createElement("span", { style: { minWidth: 0 } },
                    React.createElement("span", { style: { fontSize: '0.85em', fontWeight: 500 } },
                        skill.domain ? `${skill.domain} / ` : '',
                        skill.name),
                    skill.safety && !skill.safety.ok && (React.createElement("span", { title: skill.safety.findings.map(f => `[${f.severity}] ${f.message}` + (f.line ? ` (line ${f.line})` : '')).join('\n'), style: {
                            marginLeft: '5px',
                            fontSize: '0.66em',
                            padding: '0 5px',
                            borderRadius: '8px',
                            border: '1px solid var(--theia-editorError-foreground, #e51400)',
                            color: 'var(--theia-editorError-foreground, #e51400)',
                            whiteSpace: 'nowrap',
                        } },
                        "\u26A0 unsafe (",
                        skill.safety.score,
                        "/100)")),
                    skill.safety && skill.safety.ok && skill.safety.findings.length > 0 && (React.createElement("span", { title: skill.safety.findings.map(f => `[${f.severity}] ${f.message}` + (f.line ? ` (line ${f.line})` : '')).join('\n'), style: {
                            marginLeft: '5px',
                            fontSize: '0.66em',
                            padding: '0 5px',
                            borderRadius: '8px',
                            border: '1px solid var(--theia-editorWarning-foreground, #bf8803)',
                            color: 'var(--theia-editorWarning-foreground, #bf8803)',
                            whiteSpace: 'nowrap',
                        } }, "review")),
                    React.createElement("span", { style: { display: 'block', fontSize: '0.74em', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis' } }, skill.description))));
        }))),
        React.createElement("label", { style: labelStyle }, "Tools"),
        availableTools.length === 0 ? (React.createElement("div", { style: { fontSize: '0.78em', opacity: 0.55, marginBottom: '6px' } },
            "No tools yet. Create integration tools in the ",
            React.createElement("strong", null, "Tools"),
            " sidebar (or ask the Agent Creator to set them up), then grant them here.")) : (React.createElement("div", { style: {
                maxHeight: '160px',
                overflowY: 'auto',
                border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
                borderRadius: '4px',
                padding: '4px 6px',
                marginBottom: '6px',
            } }, availableTools.map(tool => (React.createElement("label", { key: tool.id, style: { display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '3px 0', cursor: 'pointer' }, title: tool.description },
            React.createElement("input", { type: 'checkbox', checked: tools.includes(tool.name), onChange: () => toggleTool(tool.name), disabled: busy, style: { marginTop: '2px', flexShrink: 0 } }),
            React.createElement("span", { style: { minWidth: 0 } },
                React.createElement("span", { style: { fontSize: '0.85em', fontWeight: 500 } },
                    tool.name,
                    React.createElement("span", { style: {
                            marginLeft: '5px',
                            fontSize: '0.66em',
                            padding: '0 5px',
                            borderRadius: '8px',
                            border: '1px solid var(--theia-editorWidget-border, #888)',
                            opacity: 0.8,
                            whiteSpace: 'nowrap',
                        } }, tool.method),
                    tool.enabled === false && (React.createElement("span", { style: { marginLeft: '5px', fontSize: '0.66em', opacity: 0.6 } }, "(disabled)"))),
                React.createElement("span", { style: { display: 'block', fontSize: '0.74em', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis' } }, tool.description))))))),
        error && (React.createElement("div", { style: { color: 'var(--theia-errorForeground)', fontSize: '0.82em', marginBottom: '6px' } }, error)),
        React.createElement("div", { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '4px' } },
            React.createElement("button", { className: 'theia-button secondary', onClick: onCancel, disabled: busy }, "Cancel"),
            React.createElement("button", { className: 'theia-button', onClick: handleSubmit, disabled: busy }, busy ? 'Saving…' : (isEdit ? 'Save' : 'Create')))));
};
const AgentsPanelView = ({ model }) => {
    // Keep React in sync with model changes
    const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
    React.useEffect(() => {
        const handle = model.onDidChange(() => forceUpdate());
        return () => handle.dispose();
    }, [model]);
    const [formState, setFormState] = React.useState(null);
    const [deleteConfirm, setDeleteConfirm] = React.useState(null);
    const [reflectingId, setReflectingId] = React.useState(null);
    const handleSwitchAgent = async (id) => {
        await model.switchToAgent(id);
    };
    const handleCreate = async (draft) => {
        await model.createAgent(draft);
        setFormState(null);
    };
    const handleEdit = async (draft) => {
        if ((formState === null || formState === void 0 ? void 0 : formState.mode) === 'edit') {
            await model.updateAgent(formState.agent.id, draft);
        }
        setFormState(null);
    };
    const handleDelete = async (agent) => {
        if (deleteConfirm === agent.id) {
            await model.deleteAgent(agent.id);
            setDeleteConfirm(null);
        }
        else {
            setDeleteConfirm(agent.id);
        }
    };
    // Switch to the Reflector agent and set context via the default agent pref
    const handleReflect = async (agentId) => {
        setReflectingId(agentId);
        await model.switchToAgent('reflector');
        setReflectingId(null);
    };
    const availableLlms = model.availableLlms;
    const activeAgentId = model.activeAgentId;
    // Collect all pending directives across agents for the top banner
    const pendingCount = model.agents.reduce((n, a) => { var _a; return n + ((_a = a.directives) !== null && _a !== void 0 ? _a : []).filter(d => d.status === 'pending').length; }, 0);
    return (React.createElement("div", { style: panelStyle },
        React.createElement("div", { style: { marginBottom: '4px' } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
                React.createElement("span", { className: (0, browser_1.codicon)('hubot'), style: { opacity: 0.8 } }),
                React.createElement("strong", { style: { flex: 1, fontSize: '0.95em' } }, "Agents"),
                React.createElement("button", { className: 'theia-button secondary', title: 'Refresh agent list', onClick: model.refresh, disabled: model.loading, style: { padding: '2px 8px', minWidth: 0 } },
                    React.createElement("span", { className: (0, browser_1.codicon)(model.loading ? 'sync~spin' : 'refresh') })))),
        pendingCount > 0 && (React.createElement("div", { style: {
                background: 'var(--theia-inputValidation-warningBackground)',
                border: '1px solid var(--theia-inputValidation-warningBorder)',
                borderRadius: '4px',
                padding: '6px 10px',
                fontSize: '0.78em',
                marginBottom: '6px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
            } },
            React.createElement("span", { className: (0, browser_1.codicon)('lightbulb'), style: { flexShrink: 0 } }),
            React.createElement("span", { style: { flex: 1 } },
                pendingCount,
                " directive",
                pendingCount !== 1 ? 's' : '',
                " pending review \u2014 open an agent to approve or reject."))),
        model.error && (React.createElement("div", { style: { color: 'var(--theia-errorForeground)', fontSize: '0.82em', margin: '4px 0' } }, model.error)),
        React.createElement("div", { style: sectionTitleStyle }, "Available Agents"),
        model.agents.length === 0 && !model.loading && (React.createElement("div", { style: { opacity: 0.55, fontSize: '0.85em' } }, "No agents found. Create one below.")),
        model.agents.map(agent => (React.createElement("div", { key: agent.id },
            React.createElement(AgentRow, { agent: agent, isActive: agent.id === activeAgentId, trust: model.trustScores[agent.id], onSwitch: () => handleSwitchAgent(agent.id), onDelete: () => handleDelete(agent), onEdit: () => setFormState((formState === null || formState === void 0 ? void 0 : formState.mode) === 'edit' && formState.agent.id === agent.id ? null : { mode: 'edit', agent }) }),
            agent.id !== 'reflector' && !agent.builtin && (React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '2px' } },
                React.createElement("button", { className: 'theia-button secondary', title: 'Switch to Reflector agent and analyse feedback for this agent', onClick: () => handleReflect(agent.id), disabled: reflectingId !== null, style: { padding: '1px 7px', fontSize: '0.72em', minWidth: 0 } }, reflectingId === agent.id
                    ? React.createElement("span", { className: (0, browser_1.codicon)('sync~spin') })
                    : React.createElement(React.Fragment, null,
                        React.createElement("span", { className: (0, browser_1.codicon)('sparkle'), style: { marginRight: '3px' } }),
                        "Reflect\u2026")))),
            deleteConfirm === agent.id && (React.createElement("div", { style: {
                    background: 'var(--theia-inputValidation-warningBackground)',
                    border: '1px solid var(--theia-inputValidation-warningBorder)',
                    borderRadius: '4px',
                    padding: '6px 10px',
                    fontSize: '0.82em',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '4px',
                } },
                React.createElement("span", { style: { flex: 1 } },
                    "Delete ",
                    React.createElement("strong", null, agent.name),
                    "? This cannot be undone."),
                React.createElement("button", { className: 'theia-button', onClick: () => handleDelete(agent), style: { padding: '2px 8px' } }, "Delete"),
                React.createElement("button", { className: 'theia-button secondary', onClick: () => setDeleteConfirm(null), style: { padding: '2px 8px' } }, "Cancel"))),
            (formState === null || formState === void 0 ? void 0 : formState.mode) === 'edit' && formState.agent.id === agent.id && (React.createElement(AgentForm, { initial: agent, model: model, availableLlms: availableLlms, availableSkills: model.availableSkills, availableTools: model.availableTools, onSubmit: handleEdit, onCancel: () => setFormState(null) }))))),
        React.createElement("div", { style: { marginTop: '8px' } }, (formState === null || formState === void 0 ? void 0 : formState.mode) !== 'create' ? (React.createElement("button", { className: 'theia-button secondary', style: { width: '100%', display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }, onClick: () => setFormState({ mode: 'create' }) },
            React.createElement("span", { className: (0, browser_1.codicon)('add') }),
            "New Agent")) : (React.createElement(AgentForm, { model: model, availableLlms: availableLlms, availableSkills: model.availableSkills, availableTools: model.availableTools, onSubmit: handleCreate, onCancel: () => setFormState(null) })))));
};
// ---------------------------------------------------------------------------
// ReactWidget shell
// ---------------------------------------------------------------------------
/**
 * Side-bar widget that shows the list of Command Center agents, an LLM selector, and
 * a create / edit / delete form.
 */
let AgentsPanelWidget = AgentsPanelWidget_1 = class AgentsPanelWidget extends react_widget_1.ReactWidget {
    init() {
        this.id = AgentsPanelWidget_1.ID;
        this.title.label = AgentsPanelWidget_1.LABEL;
        this.title.caption = 'Command Center Agents';
        this.title.iconClass = (0, browser_1.codicon)('robot');
        this.toDispose.push(this.model.onDidChange(() => this.update()));
        this.update();
    }
    render() {
        return React.createElement(AgentsPanelView, { model: this.model });
    }
};
exports.AgentsPanelWidget = AgentsPanelWidget;
AgentsPanelWidget.ID = exports.AGENTS_PANEL_ID;
AgentsPanelWidget.LABEL = 'Agents';
__decorate([
    (0, inversify_1.inject)(agents_model_1.AgentsModel),
    __metadata("design:type", agents_model_1.AgentsModel)
], AgentsPanelWidget.prototype, "model", void 0);
__decorate([
    (0, inversify_1.postConstruct)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AgentsPanelWidget.prototype, "init", null);
exports.AgentsPanelWidget = AgentsPanelWidget = AgentsPanelWidget_1 = __decorate([
    (0, inversify_1.injectable)()
], AgentsPanelWidget);
//# sourceMappingURL=agents-panel.js.map