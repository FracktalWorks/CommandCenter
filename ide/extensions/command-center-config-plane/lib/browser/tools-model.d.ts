import { Emitter, Event } from '@theia/core/lib/common';
import { ConfigPlaneService, IntegrationRecord, ToolDefinition, ToolDraft } from '../common/config-plane-protocol';
/**
 * Shared, singleton model behind the Tools side bar.  Holds the live tool
 * registry and the integration list (so the panel can show names), and
 * notifies the panel widget on change.
 */
export declare class ToolsModel {
    protected readonly service: ConfigPlaneService;
    protected readonly onDidChangeEmitter: Emitter<void>;
    readonly onDidChange: Event<void>;
    tools: ToolDefinition[];
    integrations: IntegrationRecord[];
    loading: boolean;
    error?: string;
    protected init(): void;
    refresh: () => Promise<void>;
    integrationName(id: string): string;
    create(draft: ToolDraft): Promise<void>;
    update(id: string, patch: Partial<ToolDraft>): Promise<void>;
    remove(id: string): Promise<void>;
}
