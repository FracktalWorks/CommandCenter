import { Emitter, Event } from '@theia/core/lib/common';
import { ConfigPlaneService, ConfigPlaneSnapshot, ConfigSection, IntegrationDraft, IntegrationGroup, IntegrationKind, IntegrationKindSpec, IntegrationRecord } from '../common/config-plane-protocol';
/**
 * Shared, singleton model behind the Integrations side bar. Holds the env
 * snapshot, the registrable kind schemas and the live registry of integrations,
 * and notifies every section view on change so a single refresh updates all.
 */
export declare class IntegrationsModel {
    protected readonly service: ConfigPlaneService;
    protected readonly onDidChangeEmitter: Emitter<void>;
    readonly onDidChange: Event<void>;
    snapshot?: ConfigPlaneSnapshot;
    kindSpecs: IntegrationKindSpec[];
    integrations: IntegrationRecord[];
    loading: boolean;
    error?: string;
    protected init(): void;
    refresh: () => Promise<void>;
    /** Env config sections belonging to a given side-bar view. */
    sectionsFor(group: IntegrationGroup): ConfigSection[];
    /** The registrable kind managed under a given side-bar view, if any. */
    kindFor(group: IntegrationGroup): IntegrationKindSpec | undefined;
    /** Registered integrations of a given kind. */
    integrationsOfKind(kind: IntegrationKind): IntegrationRecord[];
    create(draft: IntegrationDraft): Promise<void>;
    update(id: string, patch: Partial<IntegrationDraft>): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    remove(id: string): Promise<void>;
}
