/// <reference types="react" />
import * as React from '@theia/core/shared/react';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ConfigEntry, ConfigSection, IntegrationGroup, IntegrationKindSpec, IntegrationRecord } from '../common/config-plane-protocol';
import { IntegrationsModel } from './integrations-model';
/**
 * Base for a single Integrations side-bar view. Each concrete view renders the
 * sections of one {@link IntegrationGroup}, sourced from the shared
 * {@link IntegrationsModel}. Secret values are masked by the backend.
 */
export declare abstract class IntegrationSectionWidget extends ReactWidget {
    protected abstract readonly viewId: string;
    protected abstract readonly viewLabel: string;
    protected abstract readonly viewIcon: string;
    protected abstract readonly group: IntegrationGroup;
    /** Hint shown when this group has no entries / sections at all. */
    protected abstract readonly emptyHint: string;
    protected readonly model: IntegrationsModel;
    /** Transient UI state: which record is open in the form ('new' = creating). */
    protected formState?: string;
    protected init(): void;
    protected render(): React.ReactNode;
    protected renderHeader(): React.ReactNode;
    protected renderPillBadge(text: string): React.ReactNode;
    protected renderCountBadge(configured: number, total: number): React.ReactNode;
    protected renderSourceNote(): React.ReactNode;
    /** Registry block: registered integrations of this view's kind + add/edit form. */
    protected renderRegistry(): React.ReactNode;
    protected renderRegistryEmpty(kind: IntegrationKindSpec): React.ReactNode;
    protected renderIntegrationCard(kind: IntegrationKindSpec, record: IntegrationRecord): React.ReactNode;
    protected confirmDelete(record: IntegrationRecord): void;
    /** Read-only environment-variable sections for this view. */
    protected renderEnvSections(): React.ReactNode;
    /** Empty-state for env-only views with no entries. */
    protected renderEmptyState(): React.ReactNode;
    protected renderSection(section: ConfigSection): React.ReactNode;
    protected renderEntry(entry: ConfigEntry): React.ReactNode;
    protected renderValue(entry: ConfigEntry): React.ReactNode;
}
export declare class LlmsWidget extends IntegrationSectionWidget {
    static readonly ID = "commandCenter.integrations.llms";
    static readonly LABEL = "LLMs";
    protected readonly viewId = "commandCenter.integrations.llms";
    protected readonly viewLabel = "LLMs";
    protected readonly viewIcon = "sparkle";
    protected readonly group: IntegrationGroup;
    protected readonly emptyHint = "No LLM providers configured yet.";
}
export declare class McpServersWidget extends IntegrationSectionWidget {
    static readonly ID = "commandCenter.integrations.mcp";
    static readonly LABEL = "MCP Servers";
    protected readonly viewId = "commandCenter.integrations.mcp";
    protected readonly viewLabel = "MCP Servers";
    protected readonly viewIcon = "server-process";
    protected readonly group: IntegrationGroup;
    protected readonly emptyHint = "No MCP servers registered yet. Add one to expose its tools to every agent and skill.";
}
export declare class ApisWidget extends IntegrationSectionWidget {
    static readonly ID = "commandCenter.integrations.apis";
    static readonly LABEL = "APIs";
    protected readonly viewId = "commandCenter.integrations.apis";
    protected readonly viewLabel = "APIs";
    protected readonly viewIcon = "plug";
    protected readonly group: IntegrationGroup;
    protected readonly emptyHint = "No service APIs registered yet.";
}
export declare class WebhooksWidget extends IntegrationSectionWidget {
    static readonly ID = "commandCenter.integrations.webhooks";
    static readonly LABEL = "Webhooks";
    protected readonly viewId = "commandCenter.integrations.webhooks";
    protected readonly viewLabel = "Webhooks";
    protected readonly viewIcon = "radio-tower";
    protected readonly group: IntegrationGroup;
    protected readonly emptyHint = "No webhooks registered yet. Connect external events to agents and workflows.";
}
export declare class OtherIntegrationsWidget extends IntegrationSectionWidget {
    static readonly ID = "commandCenter.integrations.other";
    static readonly LABEL = "Infrastructure & Other";
    protected readonly viewId = "commandCenter.integrations.other";
    protected readonly viewLabel = "Infrastructure & Other";
    protected readonly viewIcon = "settings-gear";
    protected readonly group: IntegrationGroup;
    protected readonly emptyHint = "No infrastructure services registered yet.";
}
