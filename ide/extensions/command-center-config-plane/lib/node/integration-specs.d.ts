import { IntegrationKindSpec } from '../common/config-plane-protocol';
/**
 * Declarative schemas for every registrable integration kind. These drive both
 * the human-facing forms in the Integrations side bar and the contract agents
 * follow when creating integrations programmatically (exposed via
 * `getKindSpecs`).
 */
export declare const INTEGRATION_KIND_SPECS: IntegrationKindSpec[];
