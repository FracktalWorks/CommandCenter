import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common';
import {
    ConfigPlaneService,
    ConfigPlaneSnapshot,
    ConfigSection,
    IntegrationDraft,
    IntegrationGroup,
    IntegrationKind,
    IntegrationKindSpec,
    IntegrationRecord
} from '../common/config-plane-protocol';

/**
 * Shared, singleton model behind the Integrations side bar. Holds the env
 * snapshot, the registrable kind schemas and the live registry of integrations,
 * and notifies every section view on change so a single refresh updates all.
 */
@injectable()
export class IntegrationsModel {

    @inject(ConfigPlaneService)
    protected readonly service: ConfigPlaneService;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    snapshot?: ConfigPlaneSnapshot;
    kindSpecs: IntegrationKindSpec[] = [];
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
            const [snapshot, kindSpecs, integrations] = await Promise.all([
                this.service.getSnapshot(),
                this.service.getKindSpecs(),
                this.service.listIntegrations()
            ]);
            this.snapshot = snapshot;
            this.kindSpecs = kindSpecs;
            this.integrations = integrations;
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
        } finally {
            this.loading = false;
            this.onDidChangeEmitter.fire();
        }
    };

    /** Env config sections belonging to a given side-bar view. */
    sectionsFor(group: IntegrationGroup): ConfigSection[] {
        return this.snapshot?.sections.filter(s => s.group === group) ?? [];
    }

    /** The registrable kind managed under a given side-bar view, if any. */
    kindFor(group: IntegrationGroup): IntegrationKindSpec | undefined {
        return this.kindSpecs.find(s => s.group === group);
    }

    /** Registered integrations of a given kind. */
    integrationsOfKind(kind: IntegrationKind): IntegrationRecord[] {
        return this.integrations.filter(i => i.kind === kind);
    }

    async create(draft: IntegrationDraft): Promise<void> {
        await this.service.createIntegration(draft);
        await this.refresh();
    }

    async update(id: string, patch: Partial<IntegrationDraft>): Promise<void> {
        await this.service.updateIntegration(id, patch);
        await this.refresh();
    }

    async setEnabled(id: string, enabled: boolean): Promise<void> {
        await this.service.setIntegrationEnabled(id, enabled);
        await this.refresh();
    }

    async remove(id: string): Promise<void> {
        await this.service.deleteIntegration(id);
        await this.refresh();
    }
}
