import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser';
import {
    ConfigEntry,
    ConfigSection,
    IntegrationGroup,
    IntegrationKindSpec,
    IntegrationRecord
} from '../common/config-plane-protocol';
import { IntegrationsModel } from './integrations-model';
import { IntegrationForm } from './integration-form';

/**
 * Base for a single Integrations side-bar view. Each concrete view renders the
 * sections of one {@link IntegrationGroup}, sourced from the shared
 * {@link IntegrationsModel}. Secret values are masked by the backend.
 */
@injectable()
export abstract class IntegrationSectionWidget extends ReactWidget {

    protected abstract readonly viewId: string;
    protected abstract readonly viewLabel: string;
    protected abstract readonly viewIcon: string;
    protected abstract readonly group: IntegrationGroup;
    /** Hint shown when this group has no entries / sections at all. */
    protected abstract readonly emptyHint: string;

    @inject(IntegrationsModel)
    protected readonly model: IntegrationsModel;

    /** Transient UI state: which record is open in the form ('new' = creating). */
    protected formState?: string;

    @postConstruct()
    protected init(): void {
        this.id = this.viewId;
        this.title.label = this.viewLabel;
        this.title.caption = this.viewLabel;
        this.title.iconClass = codicon(this.viewIcon);
        this.toDispose.push(this.model.onDidChange(() => this.update()));
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <div className='command-center-integrations-view' style={{ padding: '10px 12px', overflow: 'auto', height: '100%' }}>
                {this.renderHeader()}
                {this.renderRegistry()}
                {this.renderEnvSections()}
            </div>
        );
    }

    protected renderHeader(): React.ReactNode {
        const sections = this.model.snapshot ? this.model.sectionsFor(this.group) : [];
        const envTotal = sections.reduce((n, s) => n + s.entries.length, 0);
        const envConfigured = sections.reduce((n, s) => n + s.entries.filter(e => e.set).length, 0);
        const kind = this.model.kindFor(this.group);
        const registered = kind ? this.model.integrationsOfKind(kind.kind).length : 0;
        return (
            <div style={{ marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className={codicon(this.viewIcon)} style={{ fontSize: '1.1em', opacity: 0.85 }} />
                    <strong style={{ flex: 1, fontSize: '0.95em' }}>{this.viewLabel}</strong>
                    {kind && registered > 0 && this.renderPillBadge(`${registered} registered`)}
                    {envTotal > 0 && this.renderCountBadge(envConfigured, envTotal)}
                    <button
                        className='theia-button secondary'
                        title='Reload'
                        onClick={this.model.refresh}
                        disabled={this.model.loading}
                        style={{ padding: '2px 8px', minWidth: 0 }}
                    >
                        <span className={codicon(this.model.loading ? 'sync~spin' : 'refresh')} />
                    </button>
                </div>
                <div style={{ opacity: 0.6, fontSize: '0.8em', marginTop: '4px' }}>{this.renderSourceNote()}</div>
            </div>
        );
    }

    protected renderPillBadge(text: string): React.ReactNode {
        return (
            <span
                style={{
                    fontSize: '0.75em',
                    padding: '1px 7px',
                    borderRadius: '10px',
                    background: 'var(--theia-badge-background)',
                    color: 'var(--theia-badge-foreground)',
                    whiteSpace: 'nowrap'
                }}
            >
                {text}
            </span>
        );
    }

    protected renderCountBadge(configured: number, total: number): React.ReactNode {
        const all = configured === total && total > 0;
        return (
            <span
                title={`${configured} of ${total} configured`}
                style={{
                    fontSize: '0.75em',
                    padding: '1px 7px',
                    borderRadius: '10px',
                    background: all ? 'var(--theia-successBackground, #2e7d32)' : 'var(--theia-badge-background)',
                    color: all ? 'var(--theia-button-foreground, #fff)' : 'var(--theia-badge-foreground)',
                    whiteSpace: 'nowrap'
                }}
            >
                {configured}/{total}
            </span>
        );
    }

    protected renderSourceNote(): React.ReactNode {
        const snap = this.model.snapshot;
        if (!snap?.sourceFile) {
            return 'Not yet loaded.';
        }
        return snap.usingExample
            ? 'Template defaults (.env.example — no .env found)'
            : 'Source: .env';
    }

    /** Registry block: registered integrations of this view's kind + add/edit form. */
    protected renderRegistry(): React.ReactNode {
        const kind = this.model.kindFor(this.group);
        if (!kind) {
            return undefined;
        }
        const records = this.model.integrationsOfKind(kind.kind);
        const adding = this.formState === 'new';
        return (
            <div style={{ marginBottom: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <strong style={{ flex: 1, fontSize: '0.9em' }}>{kind.title}</strong>
                    {!adding && (
                        <button
                            className='theia-button'
                            style={{ padding: '2px 10px', minWidth: 0 }}
                            title={`Add ${kind.noun}`}
                            onClick={() => { this.formState = 'new'; this.update(); }}
                        >
                            <span className={codicon('add')} style={{ marginRight: '4px' }} />
                            Add
                        </button>
                    )}
                </div>
                <div style={{ opacity: 0.65, fontSize: '0.82em', marginBottom: '10px' }}>{kind.description}</div>

                {adding && (
                    <IntegrationForm
                        spec={kind}
                        onSubmit={async draft => { await this.model.create(draft); this.formState = undefined; this.update(); }}
                        onCancel={() => { this.formState = undefined; this.update(); }}
                    />
                )}

                {records.length === 0 && !adding && this.renderRegistryEmpty(kind)}

                {records.map(record =>
                    this.formState === record.id
                        ? (
                            <IntegrationForm
                                key={record.id}
                                spec={kind}
                                record={record}
                                onSubmit={async draft => { await this.model.update(record.id, draft); this.formState = undefined; this.update(); }}
                                onCancel={() => { this.formState = undefined; this.update(); }}
                            />
                        )
                        : this.renderIntegrationCard(kind, record)
                )}
            </div>
        );
    }

    protected renderRegistryEmpty(kind: IntegrationKindSpec): React.ReactNode {
        return (
            <div
                style={{
                    border: '1px dashed var(--theia-editorWidget-border)',
                    borderRadius: '8px',
                    padding: '16px 14px',
                    textAlign: 'center',
                    opacity: 0.85,
                    marginBottom: '10px'
                }}
            >
                <div className={codicon(this.viewIcon)} style={{ fontSize: '1.6em', opacity: 0.5 }} />
                <div style={{ margin: '8px 0 4px', fontSize: '0.88em' }}>{this.emptyHint}</div>
                <button
                    className='theia-button'
                    style={{ marginTop: '6px' }}
                    onClick={() => { this.formState = 'new'; this.update(); }}
                >
                    <span className={codicon('add')} style={{ marginRight: '4px' }} />
                    Add {kind.noun}
                </button>
            </div>
        );
    }

    protected renderIntegrationCard(kind: IntegrationKindSpec, record: IntegrationRecord): React.ReactNode {
        const summaryParts = kind.fields
            .filter(f => f.type !== 'secret' && !f.managed && record.values[f.key])
            .slice(0, 3)
            .map(f => `${f.label}: ${record.values[f.key]}`);
        return (
            <div
                key={record.id}
                style={{
                    border: '1px solid var(--theia-editorWidget-border)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    marginBottom: '8px',
                    background: 'var(--theia-editorWidget-background)',
                    opacity: record.enabled ? 1 : 0.6
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span
                        title={record.enabled ? 'Enabled' : 'Disabled'}
                        style={{
                            display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                            background: record.enabled ? 'var(--theia-successBackground, #2e7d32)' : 'var(--theia-descriptionForeground, #888)',
                            opacity: record.enabled ? 1 : 0.5
                        }}
                    />
                    <strong style={{ flex: 1 }}>{record.name}</strong>
                    <button
                        className='theia-button secondary' title={record.enabled ? 'Disable' : 'Enable'}
                        style={{ padding: '1px 7px', minWidth: 0 }}
                        onClick={() => this.model.setEnabled(record.id, !record.enabled)}
                    >
                        <span className={codicon(record.enabled ? 'circle-slash' : 'check')} />
                    </button>
                    <button
                        className='theia-button secondary' title='Edit'
                        style={{ padding: '1px 7px', minWidth: 0 }}
                        onClick={() => { this.formState = record.id; this.update(); }}
                    >
                        <span className={codicon('edit')} />
                    </button>
                    <button
                        className='theia-button secondary' title='Delete'
                        style={{ padding: '1px 7px', minWidth: 0 }}
                        onClick={() => this.confirmDelete(record)}
                    >
                        <span className={codicon('trash')} />
                    </button>
                </div>
                {record.description && (
                    <div style={{ opacity: 0.7, fontSize: '0.82em', marginTop: '4px' }}>{record.description}</div>
                )}
                {summaryParts.length > 0 && (
                    <div style={{ fontSize: '0.8em', opacity: 0.75, marginTop: '6px', wordBreak: 'break-all' }}>
                        {summaryParts.join('  ·  ')}
                    </div>
                )}
                {record.secretsSet.length > 0 && (
                    <div style={{ fontSize: '0.78em', opacity: 0.7, marginTop: '4px' }}>
                        <span className={codicon('lock')} style={{ marginRight: '4px', opacity: 0.7 }} />
                        {record.secretsSet.join(', ')} <span style={{ opacity: 0.6 }}>(stored)</span>
                    </div>
                )}
            </div>
        );
    }

    protected confirmDelete(record: IntegrationRecord): void {
        // eslint-disable-next-line no-restricted-globals
        const ok = typeof window !== 'undefined' ? window.confirm(`Delete integration "${record.name}"? This cannot be undone.`) : true;
        if (ok) {
            this.model.remove(record.id);
        }
    }

    /** Read-only environment-variable sections for this view. */
    protected renderEnvSections(): React.ReactNode {
        const { error, loading, snapshot } = this.model;
        if (error) {
            return (
                <div style={{ color: 'var(--theia-editorError-foreground)' }}>
                    Failed to load configuration: {error}
                </div>
            );
        }
        if (loading && !snapshot) {
            return <div style={{ opacity: 0.7 }}>Reading environment…</div>;
        }
        const sections = this.model.sectionsFor(this.group);
        const withEntries = sections.filter(s => s.entries.length > 0);
        if (withEntries.length === 0) {
            // Pure-registry views (mcp / webhooks) have no env block; show nothing.
            return this.model.kindFor(this.group) ? undefined : this.renderEmptyState();
        }
        return (
            <div>
                <div style={{ fontSize: '0.78em', opacity: 0.55, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '4px 0 8px' }}>
                    From .env
                </div>
                {withEntries.map(section => this.renderSection(section))}
            </div>
        );
    }

    /** Empty-state for env-only views with no entries. */
    protected renderEmptyState(): React.ReactNode {
        return (
            <div
                style={{
                    border: '1px dashed var(--theia-editorWidget-border)',
                    borderRadius: '8px',
                    padding: '18px 14px',
                    textAlign: 'center',
                    opacity: 0.85
                }}
            >
                <div className={codicon(this.viewIcon)} style={{ fontSize: '1.8em', opacity: 0.5 }} />
                <div style={{ margin: '8px 0 4px', fontSize: '0.9em' }}>{this.emptyHint}</div>
            </div>
        );
    }

    protected renderSection(section: ConfigSection): React.ReactNode {
        const total = section.entries.length;
        const configured = section.entries.filter(e => e.set).length;
        return (
            <div
                key={section.id}
                style={{
                    border: '1px solid var(--theia-editorWidget-border)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    marginBottom: '10px',
                    background: 'var(--theia-editorWidget-background)'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <strong style={{ flex: 1 }}>{section.title}</strong>
                    {total > 0 && this.renderCountBadge(configured, total)}
                </div>
                <div style={{ opacity: 0.7, fontSize: '0.85em', marginTop: '3px' }}>
                    {section.description}
                </div>
                {section.entries.length === 0
                    ? <div style={{ opacity: 0.5, fontSize: '0.82em', marginTop: '6px' }}>No entries yet.</div>
                    : (
                        <table style={{ width: '100%', marginTop: '10px', borderCollapse: 'collapse' }}>
                            <tbody>
                                {section.entries.map(entry => this.renderEntry(entry))}
                            </tbody>
                        </table>
                    )}
            </div>
        );
    }

    protected renderEntry(entry: ConfigEntry): React.ReactNode {
        return (
            <tr key={entry.key} style={{ borderTop: '1px solid var(--theia-editorWidget-border)' }}>
                <td style={{ padding: '5px 8px 5px 0', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                    <span
                        title={entry.set ? 'Configured' : 'Not set'}
                        style={{
                            display: 'inline-block',
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            marginRight: '8px',
                            verticalAlign: 'middle',
                            background: entry.set
                                ? 'var(--theia-successBackground, #2e7d32)'
                                : 'var(--theia-descriptionForeground, #888)',
                            opacity: entry.set ? 1 : 0.4
                        }}
                    />
                    <code>{entry.key}</code>
                    {entry.secret && (
                        <span
                            className={codicon('lock')}
                            title='Secret — value withheld'
                            style={{ marginLeft: '6px', opacity: 0.6 }}
                        />
                    )}
                </td>
                <td style={{ padding: '5px 0', width: '100%' }}>{this.renderValue(entry)}</td>
            </tr>
        );
    }

    protected renderValue(entry: ConfigEntry): React.ReactNode {
        if (!entry.set) {
            return <span style={{ opacity: 0.45, fontStyle: 'italic' }}>not set</span>;
        }
        if (entry.secret) {
            return (
                <span title={`${entry.length ?? 0} characters`}>
                    {'•'.repeat(8)}{' '}
                    <span style={{ opacity: 0.6, fontSize: '0.85em' }}>(set)</span>
                </span>
            );
        }
        return <span style={{ wordBreak: 'break-all' }}>{entry.value}</span>;
    }
}

@injectable()
export class LlmsWidget extends IntegrationSectionWidget {
    static readonly ID = 'commandCenter.integrations.llms';
    static readonly LABEL = 'LLMs';
    protected readonly viewId = LlmsWidget.ID;
    protected readonly viewLabel = LlmsWidget.LABEL;
    protected readonly viewIcon = 'sparkle';
    protected readonly group: IntegrationGroup = 'llms';
    protected readonly emptyHint = 'No LLM providers configured yet.';
}

@injectable()
export class McpServersWidget extends IntegrationSectionWidget {
    static readonly ID = 'commandCenter.integrations.mcp';
    static readonly LABEL = 'MCP Servers';
    protected readonly viewId = McpServersWidget.ID;
    protected readonly viewLabel = McpServersWidget.LABEL;
    protected readonly viewIcon = 'server-process';
    protected readonly group: IntegrationGroup = 'mcp';
    protected readonly emptyHint = 'No MCP servers registered yet. Add one to expose its tools to every agent and skill.';
}

@injectable()
export class ApisWidget extends IntegrationSectionWidget {
    static readonly ID = 'commandCenter.integrations.apis';
    static readonly LABEL = 'APIs';
    protected readonly viewId = ApisWidget.ID;
    protected readonly viewLabel = ApisWidget.LABEL;
    protected readonly viewIcon = 'plug';
    protected readonly group: IntegrationGroup = 'apis';
    protected readonly emptyHint = 'No service APIs registered yet.';
}

@injectable()
export class WebhooksWidget extends IntegrationSectionWidget {
    static readonly ID = 'commandCenter.integrations.webhooks';
    static readonly LABEL = 'Webhooks';
    protected readonly viewId = WebhooksWidget.ID;
    protected readonly viewLabel = WebhooksWidget.LABEL;
    protected readonly viewIcon = 'radio-tower';
    protected readonly group: IntegrationGroup = 'webhooks';
    protected readonly emptyHint = 'No webhooks registered yet. Connect external events to agents and workflows.';
}

@injectable()
export class OtherIntegrationsWidget extends IntegrationSectionWidget {
    static readonly ID = 'commandCenter.integrations.other';
    static readonly LABEL = 'Infrastructure & Other';
    protected readonly viewId = OtherIntegrationsWidget.ID;
    protected readonly viewLabel = OtherIntegrationsWidget.LABEL;
    protected readonly viewIcon = 'settings-gear';
    protected readonly group: IntegrationGroup = 'other';
    protected readonly emptyHint = 'No infrastructure services registered yet.';
}
