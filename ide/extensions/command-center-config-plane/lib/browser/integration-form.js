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
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationForm = void 0;
const React = __importStar(require("@theia/core/shared/react"));
const inputStyle = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '4px 6px',
    background: 'var(--theia-input-background)',
    color: 'var(--theia-input-foreground)',
    border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
    borderRadius: '4px',
    fontSize: '0.9em'
};
const labelStyle = {
    display: 'block',
    fontSize: '0.82em',
    opacity: 0.85,
    margin: '8px 0 3px'
};
/** Evaluate a `key=value` visibility predicate against current form values. */
function isVisible(field, values) {
    var _a;
    if (field.managed) {
        return false;
    }
    if (!field.showWhen) {
        return true;
    }
    const eq = field.showWhen.indexOf('=');
    if (eq < 0) {
        return true;
    }
    const key = field.showWhen.slice(0, eq);
    const expected = field.showWhen.slice(eq + 1).split(',').map(v => v.trim());
    const actual = (_a = values[key]) !== null && _a !== void 0 ? _a : '';
    return expected.includes(actual);
}
/**
 * Schema-driven create/edit form for one integration. Renders inputs from the
 * kind's {@link IntegrationFieldSpec}s, so adding a field to a spec is enough to
 * expose it here — no bespoke form code per kind.
 */
const IntegrationForm = ({ spec, record, onSubmit, onCancel }) => {
    var _a, _b;
    const initialValues = React.useMemo(() => {
        var _a, _b;
        const v = {};
        for (const f of spec.fields) {
            if (f.type !== 'secret') {
                v[f.key] = (_b = (_a = record === null || record === void 0 ? void 0 : record.values[f.key]) !== null && _a !== void 0 ? _a : f.default) !== null && _b !== void 0 ? _b : '';
            }
        }
        return v;
    }, [spec, record]);
    const [name, setName] = React.useState((_a = record === null || record === void 0 ? void 0 : record.name) !== null && _a !== void 0 ? _a : '');
    const [description, setDescription] = React.useState((_b = record === null || record === void 0 ? void 0 : record.description) !== null && _b !== void 0 ? _b : '');
    const [values, setValues] = React.useState(initialValues);
    const [secrets, setSecrets] = React.useState({});
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState();
    const setValue = (key, val) => setValues(prev => ({ ...prev, [key]: val }));
    const setSecret = (key, val) => setSecrets(prev => ({ ...prev, [key]: val }));
    const submit = async () => {
        var _a;
        setError(undefined);
        if (!name.trim()) {
            setError('Name is required.');
            return;
        }
        for (const f of spec.fields) {
            if (f.required && isVisible(f, values) && f.type !== 'secret' && !((_a = values[f.key]) !== null && _a !== void 0 ? _a : '').trim()) {
                setError(`${f.label} is required.`);
                return;
            }
        }
        setBusy(true);
        try {
            // Only send secrets the user actually typed (non-empty).
            const secretsOut = {};
            for (const [k, v] of Object.entries(secrets)) {
                if (v !== '') {
                    secretsOut[k] = v;
                }
            }
            await onSubmit({
                kind: spec.kind,
                name: name.trim(),
                description: description.trim() || undefined,
                values,
                secrets: secretsOut
            });
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    };
    const renderField = (field) => {
        var _a, _b, _c, _d, _e, _f;
        if (!isVisible(field, values)) {
            return undefined;
        }
        const id = `cc-field-${field.key}`;
        let control;
        if (field.type === 'select') {
            control = (React.createElement("select", { id: id, style: inputStyle, value: (_a = values[field.key]) !== null && _a !== void 0 ? _a : '', onChange: e => setValue(field.key, e.target.value) }, ((_b = field.options) !== null && _b !== void 0 ? _b : []).map(opt => React.createElement("option", { key: opt, value: opt }, opt))));
        }
        else if (field.type === 'multiline') {
            control = (React.createElement("textarea", { id: id, style: { ...inputStyle, minHeight: '52px', fontFamily: 'var(--theia-code-font-family)' }, placeholder: field.placeholder, value: (_c = values[field.key]) !== null && _c !== void 0 ? _c : '', onChange: e => setValue(field.key, e.target.value) }));
        }
        else if (field.type === 'secret') {
            const alreadySet = !!(record === null || record === void 0 ? void 0 : record.secretsSet.includes(field.key));
            control = (React.createElement("input", { id: id, type: 'password', style: inputStyle, placeholder: alreadySet ? '•••••••• (stored — leave blank to keep)' : field.placeholder, value: (_d = secrets[field.key]) !== null && _d !== void 0 ? _d : '', onChange: e => setSecret(field.key, e.target.value) }));
        }
        else if (field.type === 'boolean') {
            control = (React.createElement("input", { id: id, type: 'checkbox', checked: ((_e = values[field.key]) !== null && _e !== void 0 ? _e : '') === 'true', onChange: e => setValue(field.key, e.target.checked ? 'true' : 'false') }));
        }
        else {
            control = (React.createElement("input", { id: id, type: field.type === 'number' ? 'number' : 'text', style: inputStyle, placeholder: field.placeholder, value: (_f = values[field.key]) !== null && _f !== void 0 ? _f : '', onChange: e => setValue(field.key, e.target.value) }));
        }
        return (React.createElement("div", { key: field.key },
            React.createElement("label", { htmlFor: id, style: labelStyle },
                field.label,
                field.required ? ' *' : ''),
            control,
            field.help && (React.createElement("div", { style: { fontSize: '0.75em', opacity: 0.6, marginTop: '2px' } }, field.help))));
    };
    return (React.createElement("div", { style: {
            border: '1px solid var(--theia-focusBorder, var(--theia-editorWidget-border))',
            borderRadius: '8px',
            padding: '12px',
            marginBottom: '10px',
            background: 'var(--theia-editorWidget-background)'
        } },
        React.createElement("strong", { style: { fontSize: '0.92em' } }, record ? `Edit ${spec.noun}` : `New ${spec.noun}`),
        React.createElement("label", { htmlFor: 'cc-field-name', style: labelStyle }, "Name *"),
        React.createElement("input", { id: 'cc-field-name', style: inputStyle, placeholder: `My ${spec.noun}`, value: name, onChange: e => setName(e.target.value) }),
        React.createElement("label", { htmlFor: 'cc-field-description', style: labelStyle }, "Description"),
        React.createElement("input", { id: 'cc-field-description', style: inputStyle, placeholder: 'What this integration is for', value: description, onChange: e => setDescription(e.target.value) }),
        spec.fields.map(renderField),
        error && (React.createElement("div", { style: { color: 'var(--theia-editorError-foreground)', fontSize: '0.82em', marginTop: '8px' } }, error)),
        React.createElement("div", { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
            React.createElement("button", { className: 'theia-button', onClick: submit, disabled: busy }, busy ? 'Saving…' : (record ? 'Save' : 'Create')),
            React.createElement("button", { className: 'theia-button secondary', onClick: onCancel, disabled: busy }, "Cancel"))));
};
exports.IntegrationForm = IntegrationForm;
//# sourceMappingURL=integration-form.js.map