import * as React from '@theia/core/shared/react';
import {
    IntegrationDraft,
    IntegrationFieldSpec,
    IntegrationKindSpec,
    IntegrationRecord
} from '../common/config-plane-protocol';

export interface IntegrationFormProps {
    spec: IntegrationKindSpec;
    /** Existing record when editing; undefined when creating. */
    record?: IntegrationRecord;
    onSubmit: (draft: IntegrationDraft) => Promise<void>;
    onCancel: () => void;
}

const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '4px 6px',
    background: 'var(--theia-input-background)',
    color: 'var(--theia-input-foreground)',
    border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
    borderRadius: '4px',
    fontSize: '0.9em'
};

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.82em',
    opacity: 0.85,
    margin: '8px 0 3px'
};

/** Evaluate a `key=value` visibility predicate against current form values. */
function isVisible(field: IntegrationFieldSpec, values: Record<string, string>): boolean {
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
    const actual = values[key] ?? '';
    return expected.includes(actual);
}

/**
 * Schema-driven create/edit form for one integration. Renders inputs from the
 * kind's {@link IntegrationFieldSpec}s, so adding a field to a spec is enough to
 * expose it here — no bespoke form code per kind.
 */
export const IntegrationForm: React.FC<IntegrationFormProps> = ({ spec, record, onSubmit, onCancel }) => {
    const initialValues = React.useMemo(() => {
        const v: Record<string, string> = {};
        for (const f of spec.fields) {
            if (f.type !== 'secret') {
                v[f.key] = record?.values[f.key] ?? f.default ?? '';
            }
        }
        return v;
    }, [spec, record]);

    const [name, setName] = React.useState(record?.name ?? '');
    const [description, setDescription] = React.useState(record?.description ?? '');
    const [values, setValues] = React.useState<Record<string, string>>(initialValues);
    const [secrets, setSecrets] = React.useState<Record<string, string>>({});
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>();

    const setValue = (key: string, val: string) => setValues(prev => ({ ...prev, [key]: val }));
    const setSecret = (key: string, val: string) => setSecrets(prev => ({ ...prev, [key]: val }));

    const submit = async () => {
        setError(undefined);
        if (!name.trim()) {
            setError('Name is required.');
            return;
        }
        for (const f of spec.fields) {
            if (f.required && isVisible(f, values) && f.type !== 'secret' && !(values[f.key] ?? '').trim()) {
                setError(`${f.label} is required.`);
                return;
            }
        }
        setBusy(true);
        try {
            // Only send secrets the user actually typed (non-empty).
            const secretsOut: Record<string, string> = {};
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
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    };

    const renderField = (field: IntegrationFieldSpec): React.ReactNode => {
        if (!isVisible(field, values)) {
            return undefined;
        }
        const id = `cc-field-${field.key}`;
        let control: React.ReactNode;
        if (field.type === 'select') {
            control = (
                <select
                    id={id}
                    style={inputStyle}
                    value={values[field.key] ?? ''}
                    onChange={e => setValue(field.key, e.target.value)}
                >
                    {(field.options ?? []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
            );
        } else if (field.type === 'multiline') {
            control = (
                <textarea
                    id={id}
                    style={{ ...inputStyle, minHeight: '52px', fontFamily: 'var(--theia-code-font-family)' }}
                    placeholder={field.placeholder}
                    value={values[field.key] ?? ''}
                    onChange={e => setValue(field.key, e.target.value)}
                />
            );
        } else if (field.type === 'secret') {
            const alreadySet = !!record?.secretsSet.includes(field.key);
            control = (
                <input
                    id={id}
                    type='password'
                    style={inputStyle}
                    placeholder={alreadySet ? '•••••••• (stored — leave blank to keep)' : field.placeholder}
                    value={secrets[field.key] ?? ''}
                    onChange={e => setSecret(field.key, e.target.value)}
                />
            );
        } else if (field.type === 'boolean') {
            control = (
                <input
                    id={id}
                    type='checkbox'
                    checked={(values[field.key] ?? '') === 'true'}
                    onChange={e => setValue(field.key, e.target.checked ? 'true' : 'false')}
                />
            );
        } else {
            control = (
                <input
                    id={id}
                    type={field.type === 'number' ? 'number' : 'text'}
                    style={inputStyle}
                    placeholder={field.placeholder}
                    value={values[field.key] ?? ''}
                    onChange={e => setValue(field.key, e.target.value)}
                />
            );
        }
        return (
            <div key={field.key}>
                <label htmlFor={id} style={labelStyle}>
                    {field.label}{field.required ? ' *' : ''}
                </label>
                {control}
                {field.help && (
                    <div style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '2px' }}>{field.help}</div>
                )}
            </div>
        );
    };

    return (
        <div
            style={{
                border: '1px solid var(--theia-focusBorder, var(--theia-editorWidget-border))',
                borderRadius: '8px',
                padding: '12px',
                marginBottom: '10px',
                background: 'var(--theia-editorWidget-background)'
            }}
        >
            <strong style={{ fontSize: '0.92em' }}>
                {record ? `Edit ${spec.noun}` : `New ${spec.noun}`}
            </strong>

            <label htmlFor='cc-field-name' style={labelStyle}>Name *</label>
            <input
                id='cc-field-name'
                style={inputStyle}
                placeholder={`My ${spec.noun}`}
                value={name}
                onChange={e => setName(e.target.value)}
            />

            <label htmlFor='cc-field-description' style={labelStyle}>Description</label>
            <input
                id='cc-field-description'
                style={inputStyle}
                placeholder='What this integration is for'
                value={description}
                onChange={e => setDescription(e.target.value)}
            />

            {spec.fields.map(renderField)}

            {error && (
                <div style={{ color: 'var(--theia-editorError-foreground)', fontSize: '0.82em', marginTop: '8px' }}>
                    {error}
                </div>
            )}

            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                <button className='theia-button' onClick={submit} disabled={busy}>
                    {busy ? 'Saving…' : (record ? 'Save' : 'Create')}
                </button>
                <button className='theia-button secondary' onClick={onCancel} disabled={busy}>
                    Cancel
                </button>
            </div>
        </div>
    );
};
