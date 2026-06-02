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
var LlmsWidget_1, McpServersWidget_1, ApisWidget_1, WebhooksWidget_1, OtherIntegrationsWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OtherIntegrationsWidget = exports.WebhooksWidget = exports.ApisWidget = exports.McpServersWidget = exports.LlmsWidget = exports.IntegrationSectionWidget = void 0;
const React = __importStar(require("@theia/core/shared/react"));
const inversify_1 = require("@theia/core/shared/inversify");
const react_widget_1 = require("@theia/core/lib/browser/widgets/react-widget");
const browser_1 = require("@theia/core/lib/browser");
const integrations_model_1 = require("./integrations-model");
const integration_form_1 = require("./integration-form");
/**
 * Base for a single Integrations side-bar view. Each concrete view renders the
 * sections of one {@link IntegrationGroup}, sourced from the shared
 * {@link IntegrationsModel}. Secret values are masked by the backend.
 */
let IntegrationSectionWidget = class IntegrationSectionWidget extends react_widget_1.ReactWidget {
    init() {
        this.id = this.viewId;
        this.title.label = this.viewLabel;
        this.title.caption = this.viewLabel;
        this.title.iconClass = (0, browser_1.codicon)(this.viewIcon);
        this.toDispose.push(this.model.onDidChange(() => this.update()));
        this.update();
    }
    render() {
        return (React.createElement("div", { className: 'command-center-integrations-view', style: { padding: '10px 12px', overflow: 'auto', height: '100%' } },
            this.renderHeader(),
            this.renderRegistry(),
            this.renderEnvSections()));
    }
    renderHeader() {
        const sections = this.model.snapshot ? this.model.sectionsFor(this.group) : [];
        const envTotal = sections.reduce((n, s) => n + s.entries.length, 0);
        const envConfigured = sections.reduce((n, s) => n + s.entries.filter(e => e.set).length, 0);
        const kind = this.model.kindFor(this.group);
        const registered = kind ? this.model.integrationsOfKind(kind.kind).length : 0;
        return (React.createElement("div", { style: { marginBottom: '12px' } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                React.createElement("span", { className: (0, browser_1.codicon)(this.viewIcon), style: { fontSize: '1.1em', opacity: 0.85 } }),
                React.createElement("strong", { style: { flex: 1, fontSize: '0.95em' } }, this.viewLabel),
                kind && registered > 0 && this.renderPillBadge(`${registered} registered`),
                envTotal > 0 && this.renderCountBadge(envConfigured, envTotal),
                React.createElement("button", { className: 'theia-button secondary', title: 'Reload', onClick: this.model.refresh, disabled: this.model.loading, style: { padding: '2px 8px', minWidth: 0 } },
                    React.createElement("span", { className: (0, browser_1.codicon)(this.model.loading ? 'sync~spin' : 'refresh') }))),
            React.createElement("div", { style: { opacity: 0.6, fontSize: '0.8em', marginTop: '4px' } }, this.renderSourceNote())));
    }
    renderPillBadge(text) {
        return (React.createElement("span", { style: {
                fontSize: '0.75em',
                padding: '1px 7px',
                borderRadius: '10px',
                background: 'var(--theia-badge-background)',
                color: 'var(--theia-badge-foreground)',
                whiteSpace: 'nowrap'
            } }, text));
    }
    renderCountBadge(configured, total) {
        const all = configured === total && total > 0;
        return (React.createElement("span", { title: `${configured} of ${total} configured`, style: {
                fontSize: '0.75em',
                padding: '1px 7px',
                borderRadius: '10px',
                background: all ? 'var(--theia-successBackground, #2e7d32)' : 'var(--theia-badge-background)',
                color: all ? 'var(--theia-button-foreground, #fff)' : 'var(--theia-badge-foreground)',
                whiteSpace: 'nowrap'
            } },
            configured,
            "/",
            total));
    }
    renderSourceNote() {
        const snap = this.model.snapshot;
        if (!(snap === null || snap === void 0 ? void 0 : snap.sourceFile)) {
            return 'Not yet loaded.';
        }
        return snap.usingExample
            ? 'Template defaults (.env.example — no .env found)'
            : 'Source: .env';
    }
    /** Registry block: registered integrations of this view's kind + add/edit form. */
    renderRegistry() {
        const kind = this.model.kindFor(this.group);
        if (!kind) {
            return undefined;
        }
        const records = this.model.integrationsOfKind(kind.kind);
        const adding = this.formState === 'new';
        return (React.createElement("div", { style: { marginBottom: '14px' } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
                React.createElement("strong", { style: { flex: 1, fontSize: '0.9em' } }, kind.title),
                !adding && (React.createElement("button", { className: 'theia-button', style: { padding: '2px 10px', minWidth: 0 }, title: `Add ${kind.noun}`, onClick: () => { this.formState = 'new'; this.update(); } },
                    React.createElement("span", { className: (0, browser_1.codicon)('add'), style: { marginRight: '4px' } }),
                    "Add"))),
            React.createElement("div", { style: { opacity: 0.65, fontSize: '0.82em', marginBottom: '10px' } }, kind.description),
            adding && (React.createElement(integration_form_1.IntegrationForm, { spec: kind, onSubmit: async (draft) => { await this.model.create(draft); this.formState = undefined; this.update(); }, onCancel: () => { this.formState = undefined; this.update(); } })),
            records.length === 0 && !adding && this.renderRegistryEmpty(kind),
            records.map(record => this.formState === record.id
                ? (React.createElement(integration_form_1.IntegrationForm, { key: record.id, spec: kind, record: record, onSubmit: async (draft) => { await this.model.update(record.id, draft); this.formState = undefined; this.update(); }, onCancel: () => { this.formState = undefined; this.update(); } }))
                : this.renderIntegrationCard(kind, record))));
    }
    renderRegistryEmpty(kind) {
        return (React.createElement("div", { style: {
                border: '1px dashed var(--theia-editorWidget-border)',
                borderRadius: '8px',
                padding: '16px 14px',
                textAlign: 'center',
                opacity: 0.85,
                marginBottom: '10px'
            } },
            React.createElement("div", { className: (0, browser_1.codicon)(this.viewIcon), style: { fontSize: '1.6em', opacity: 0.5 } }),
            React.createElement("div", { style: { margin: '8px 0 4px', fontSize: '0.88em' } }, this.emptyHint),
            React.createElement("button", { className: 'theia-button', style: { marginTop: '6px' }, onClick: () => { this.formState = 'new'; this.update(); } },
                React.createElement("span", { className: (0, browser_1.codicon)('add'), style: { marginRight: '4px' } }),
                "Add ",
                kind.noun)));
    }
    renderIntegrationCard(kind, record) {
        const summaryParts = kind.fields
            .filter(f => f.type !== 'secret' && !f.managed && record.values[f.key])
            .slice(0, 3)
            .map(f => `${f.label}: ${record.values[f.key]}`);
        return (React.createElement("div", { key: record.id, style: {
                border: '1px solid var(--theia-editorWidget-border)',
                borderRadius: '8px',
                padding: '10px 12px',
                marginBottom: '8px',
                background: 'var(--theia-editorWidget-background)',
                opacity: record.enabled ? 1 : 0.6
            } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                React.createElement("span", { title: record.enabled ? 'Enabled' : 'Disabled', style: {
                        display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                        background: record.enabled ? 'var(--theia-successBackground, #2e7d32)' : 'var(--theia-descriptionForeground, #888)',
                        opacity: record.enabled ? 1 : 0.5
                    } }),
                React.createElement("strong", { style: { flex: 1 } }, record.name),
                React.createElement("button", { className: 'theia-button secondary', title: record.enabled ? 'Disable' : 'Enable', style: { padding: '1px 7px', minWidth: 0 }, onClick: () => this.model.setEnabled(record.id, !record.enabled) },
                    React.createElement("span", { className: (0, browser_1.codicon)(record.enabled ? 'circle-slash' : 'check') })),
                React.createElement("button", { className: 'theia-button secondary', title: 'Edit', style: { padding: '1px 7px', minWidth: 0 }, onClick: () => { this.formState = record.id; this.update(); } },
                    React.createElement("span", { className: (0, browser_1.codicon)('edit') })),
                React.createElement("button", { className: 'theia-button secondary', title: 'Delete', style: { padding: '1px 7px', minWidth: 0 }, onClick: () => this.confirmDelete(record) },
                    React.createElement("span", { className: (0, browser_1.codicon)('trash') }))),
            record.description && (React.createElement("div", { style: { opacity: 0.7, fontSize: '0.82em', marginTop: '4px' } }, record.description)),
            summaryParts.length > 0 && (React.createElement("div", { style: { fontSize: '0.8em', opacity: 0.75, marginTop: '6px', wordBreak: 'break-all' } }, summaryParts.join('  ·  '))),
            record.secretsSet.length > 0 && (React.createElement("div", { style: { fontSize: '0.78em', opacity: 0.7, marginTop: '4px' } },
                React.createElement("span", { className: (0, browser_1.codicon)('lock'), style: { marginRight: '4px', opacity: 0.7 } }),
                record.secretsSet.join(', '),
                " ",
                React.createElement("span", { style: { opacity: 0.6 } }, "(stored)")))));
    }
    confirmDelete(record) {
        // eslint-disable-next-line no-restricted-globals
        const ok = typeof window !== 'undefined' ? window.confirm(`Delete integration "${record.name}"? This cannot be undone.`) : true;
        if (ok) {
            this.model.remove(record.id);
        }
    }
    /** Read-only environment-variable sections for this view. */
    renderEnvSections() {
        const { error, loading, snapshot } = this.model;
        if (error) {
            return (React.createElement("div", { style: { color: 'var(--theia-editorError-foreground)' } },
                "Failed to load configuration: ",
                error));
        }
        if (loading && !snapshot) {
            return React.createElement("div", { style: { opacity: 0.7 } }, "Reading environment\u2026");
        }
        const sections = this.model.sectionsFor(this.group);
        const withEntries = sections.filter(s => s.entries.length > 0);
        if (withEntries.length === 0) {
            // Pure-registry views (mcp / webhooks) have no env block; show nothing.
            return this.model.kindFor(this.group) ? undefined : this.renderEmptyState();
        }
        return (React.createElement("div", null,
            React.createElement("div", { style: { fontSize: '0.78em', opacity: 0.55, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '4px 0 8px' } }, "From .env"),
            withEntries.map(section => this.renderSection(section))));
    }
    /** Empty-state for env-only views with no entries. */
    renderEmptyState() {
        return (React.createElement("div", { style: {
                border: '1px dashed var(--theia-editorWidget-border)',
                borderRadius: '8px',
                padding: '18px 14px',
                textAlign: 'center',
                opacity: 0.85
            } },
            React.createElement("div", { className: (0, browser_1.codicon)(this.viewIcon), style: { fontSize: '1.8em', opacity: 0.5 } }),
            React.createElement("div", { style: { margin: '8px 0 4px', fontSize: '0.9em' } }, this.emptyHint)));
    }
    renderSection(section) {
        const total = section.entries.length;
        const configured = section.entries.filter(e => e.set).length;
        return (React.createElement("div", { key: section.id, style: {
                border: '1px solid var(--theia-editorWidget-border)',
                borderRadius: '8px',
                padding: '10px 12px',
                marginBottom: '10px',
                background: 'var(--theia-editorWidget-background)'
            } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                React.createElement("strong", { style: { flex: 1 } }, section.title),
                total > 0 && this.renderCountBadge(configured, total)),
            React.createElement("div", { style: { opacity: 0.7, fontSize: '0.85em', marginTop: '3px' } }, section.description),
            section.entries.length === 0
                ? React.createElement("div", { style: { opacity: 0.5, fontSize: '0.82em', marginTop: '6px' } }, "No entries yet.")
                : (React.createElement("table", { style: { width: '100%', marginTop: '10px', borderCollapse: 'collapse' } },
                    React.createElement("tbody", null, section.entries.map(entry => this.renderEntry(entry)))))));
    }
    renderEntry(entry) {
        return (React.createElement("tr", { key: entry.key, style: { borderTop: '1px solid var(--theia-editorWidget-border)' } },
            React.createElement("td", { style: { padding: '5px 8px 5px 0', verticalAlign: 'top', whiteSpace: 'nowrap' } },
                React.createElement("span", { title: entry.set ? 'Configured' : 'Not set', style: {
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
                    } }),
                React.createElement("code", null, entry.key),
                entry.secret && (React.createElement("span", { className: (0, browser_1.codicon)('lock'), title: 'Secret \u2014 value withheld', style: { marginLeft: '6px', opacity: 0.6 } }))),
            React.createElement("td", { style: { padding: '5px 0', width: '100%' } }, this.renderValue(entry))));
    }
    renderValue(entry) {
        var _a;
        if (!entry.set) {
            return React.createElement("span", { style: { opacity: 0.45, fontStyle: 'italic' } }, "not set");
        }
        if (entry.secret) {
            return (React.createElement("span", { title: `${(_a = entry.length) !== null && _a !== void 0 ? _a : 0} characters` },
                '•'.repeat(8),
                ' ',
                React.createElement("span", { style: { opacity: 0.6, fontSize: '0.85em' } }, "(set)")));
        }
        return React.createElement("span", { style: { wordBreak: 'break-all' } }, entry.value);
    }
};
exports.IntegrationSectionWidget = IntegrationSectionWidget;
__decorate([
    (0, inversify_1.inject)(integrations_model_1.IntegrationsModel),
    __metadata("design:type", integrations_model_1.IntegrationsModel)
], IntegrationSectionWidget.prototype, "model", void 0);
__decorate([
    (0, inversify_1.postConstruct)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], IntegrationSectionWidget.prototype, "init", null);
exports.IntegrationSectionWidget = IntegrationSectionWidget = __decorate([
    (0, inversify_1.injectable)()
], IntegrationSectionWidget);
let LlmsWidget = LlmsWidget_1 = class LlmsWidget extends IntegrationSectionWidget {
    constructor() {
        super(...arguments);
        this.viewId = LlmsWidget_1.ID;
        this.viewLabel = LlmsWidget_1.LABEL;
        this.viewIcon = 'sparkle';
        this.group = 'llms';
        this.emptyHint = 'No LLM providers configured yet.';
    }
};
exports.LlmsWidget = LlmsWidget;
LlmsWidget.ID = 'commandCenter.integrations.llms';
LlmsWidget.LABEL = 'LLMs';
exports.LlmsWidget = LlmsWidget = LlmsWidget_1 = __decorate([
    (0, inversify_1.injectable)()
], LlmsWidget);
let McpServersWidget = McpServersWidget_1 = class McpServersWidget extends IntegrationSectionWidget {
    constructor() {
        super(...arguments);
        this.viewId = McpServersWidget_1.ID;
        this.viewLabel = McpServersWidget_1.LABEL;
        this.viewIcon = 'server-process';
        this.group = 'mcp';
        this.emptyHint = 'No MCP servers registered yet. Add one to expose its tools to every agent and skill.';
    }
};
exports.McpServersWidget = McpServersWidget;
McpServersWidget.ID = 'commandCenter.integrations.mcp';
McpServersWidget.LABEL = 'MCP Servers';
exports.McpServersWidget = McpServersWidget = McpServersWidget_1 = __decorate([
    (0, inversify_1.injectable)()
], McpServersWidget);
let ApisWidget = ApisWidget_1 = class ApisWidget extends IntegrationSectionWidget {
    constructor() {
        super(...arguments);
        this.viewId = ApisWidget_1.ID;
        this.viewLabel = ApisWidget_1.LABEL;
        this.viewIcon = 'plug';
        this.group = 'apis';
        this.emptyHint = 'No service APIs registered yet.';
    }
};
exports.ApisWidget = ApisWidget;
ApisWidget.ID = 'commandCenter.integrations.apis';
ApisWidget.LABEL = 'APIs';
exports.ApisWidget = ApisWidget = ApisWidget_1 = __decorate([
    (0, inversify_1.injectable)()
], ApisWidget);
let WebhooksWidget = WebhooksWidget_1 = class WebhooksWidget extends IntegrationSectionWidget {
    constructor() {
        super(...arguments);
        this.viewId = WebhooksWidget_1.ID;
        this.viewLabel = WebhooksWidget_1.LABEL;
        this.viewIcon = 'radio-tower';
        this.group = 'webhooks';
        this.emptyHint = 'No webhooks registered yet. Connect external events to agents and workflows.';
    }
};
exports.WebhooksWidget = WebhooksWidget;
WebhooksWidget.ID = 'commandCenter.integrations.webhooks';
WebhooksWidget.LABEL = 'Webhooks';
exports.WebhooksWidget = WebhooksWidget = WebhooksWidget_1 = __decorate([
    (0, inversify_1.injectable)()
], WebhooksWidget);
let OtherIntegrationsWidget = OtherIntegrationsWidget_1 = class OtherIntegrationsWidget extends IntegrationSectionWidget {
    constructor() {
        super(...arguments);
        this.viewId = OtherIntegrationsWidget_1.ID;
        this.viewLabel = OtherIntegrationsWidget_1.LABEL;
        this.viewIcon = 'settings-gear';
        this.group = 'other';
        this.emptyHint = 'No infrastructure services registered yet.';
    }
};
exports.OtherIntegrationsWidget = OtherIntegrationsWidget;
OtherIntegrationsWidget.ID = 'commandCenter.integrations.other';
OtherIntegrationsWidget.LABEL = 'Infrastructure & Other';
exports.OtherIntegrationsWidget = OtherIntegrationsWidget = OtherIntegrationsWidget_1 = __decorate([
    (0, inversify_1.injectable)()
], OtherIntegrationsWidget);
//# sourceMappingURL=integration-widgets.js.map