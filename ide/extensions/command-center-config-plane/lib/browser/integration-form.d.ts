/// <reference types="react" />
import * as React from '@theia/core/shared/react';
import { IntegrationDraft, IntegrationKindSpec, IntegrationRecord } from '../common/config-plane-protocol';
export interface IntegrationFormProps {
    spec: IntegrationKindSpec;
    /** Existing record when editing; undefined when creating. */
    record?: IntegrationRecord;
    onSubmit: (draft: IntegrationDraft) => Promise<void>;
    onCancel: () => void;
}
/**
 * Schema-driven create/edit form for one integration. Renders inputs from the
 * kind's {@link IntegrationFieldSpec}s, so adding a field to a spec is enough to
 * expose it here — no bespoke form code per kind.
 */
export declare const IntegrationForm: React.FC<IntegrationFormProps>;
