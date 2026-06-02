import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common';
import {
    ConfigPlaneService,
    IntegrationRecord,
    ToolDefinition,
    ToolDraft,
} from '../common/config-plane-protocol';

/**
 * Shared, singleton model behind the Tools side bar.  Holds the live tool
 * registry and the integration list (so the panel can show names), and
 * notifies the panel widget on change.
 */
@injectable()
export class ToolsModel {

    @inject(ConfigPlaneService)
    protected readonly service: ConfigPlaneService;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    tools: ToolDefinition[] = [];
    integrations: IntegrationRecord[] = [];
    loading = false;
    error?: string;

    @postConstruct()
    protected init(): void {
        this.refresh();
    }

    refresh = async (): Promise<void> => {
        this.loading = true;
        this.error = undefined;
        this.onDidChangeEmitter.fire();
        try {
            const [tools, integrations] = await Promise.all([
                this.service.listTools(),
                this.service.listIntegrations(),
            ]);
            this.tools = tools;
            this.integrations = integrations;
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
        } finally {
            this.loading = false;
            this.onDidChangeEmitter.fire();
        }
    };

    integrationName(id: string): string {
        return this.integrations.find(i => i.id === id)?.name ?? id;
    }

    async create(draft: ToolDraft): Promise<void> {
        await this.service.createTool(draft);
        await this.refresh();
    }

    async update(id: string, patch: Partial<ToolDraft>): Promise<void> {
        await this.service.updateTool(id, patch);
        await this.refresh();
    }

    async remove(id: string): Promise<void> {
        await this.service.deleteTool(id);
        await this.refresh();
    }
}
