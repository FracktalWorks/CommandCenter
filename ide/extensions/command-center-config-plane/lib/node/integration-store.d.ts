/// <reference types="node" />
/// <reference types="node" />
import { IntegrationDraft, IntegrationKind, IntegrationRecord } from '../common/config-plane-protocol';
/** On-disk shape of a stored integration (secrets encrypted at rest). */
interface StoredIntegration {
    id: string;
    kind: IntegrationKind;
    name: string;
    description?: string;
    enabled: boolean;
    values: Record<string, string>;
    /** Encrypted secret blobs, keyed by field key. */
    secrets: Record<string, string>;
    createdAt: string;
    updatedAt: string;
}
interface StoreFile {
    version: number;
    integrations: StoredIntegration[];
}
/**
 * File-backed registry of integrations, stored under `.command-center/` next to
 * the project root. Secret field values are encrypted at rest with AES-256-GCM
 * using a locally generated master key. The plaintext JSON manifest (minus
 * secrets) is human- and agent-editable; the store always re-reads from disk
 * before each operation so external edits are picked up.
 */
export declare class IntegrationStore {
    protected readonly dir: string;
    protected readonly storeFile: string;
    protected readonly keyFile: string;
    constructor(rootDir: string);
    list(): Promise<IntegrationRecord[]>;
    create(draft: IntegrationDraft): Promise<IntegrationRecord>;
    update(id: string, patch: Partial<IntegrationDraft>): Promise<IntegrationRecord>;
    setEnabled(id: string, enabled: boolean): Promise<IntegrationRecord>;
    delete(id: string): Promise<void>;
    protected toRecord(stored: StoredIntegration): IntegrationRecord;
    protected validateKind(kind: IntegrationKind): void;
    /** Secret vs non-secret declared field keys for a kind. */
    protected fieldKeys(kind: IntegrationKind): {
        secret: Set<string>;
        nonSecret: Set<string>;
    };
    /**
     * Route a combined set of provided values + secrets into the correct buckets
     * by declared field type, regardless of which bucket the caller used. Secret
     * fields go to `secretsPlain` (plaintext, for the caller to encrypt); every
     * other declared field goes to `values`. This makes the store tolerant of
     * callers (e.g. chat agents) that put a non-secret field like `clientId`
     * under `secrets`, or a secret under `values`. Unknown keys are dropped.
     */
    protected routeBuckets(kind: IntegrationKind, values?: Record<string, string>, secrets?: Record<string, string>): {
        values: Record<string, string>;
        secretsPlain: Record<string, string>;
    };
    /** Encrypt each plaintext value in a map, skipping empties. */
    protected encryptMap(plain: Record<string, string>): Record<string, string>;
    /**
     * Re-route any persisted field sitting in the wrong bucket into the correct
     * one, based on the kind's schema: a non-secret field stored (encrypted)
     * under `secrets` is decrypted back into `values`, and a secret field stored
     * in plaintext `values` is encrypted into `secrets`. Fixes records written
     * before bucket routing existed (e.g. an OAuth `clientId` saved as a secret).
     * Mutates `stored` in place; returns true when anything moved.
     */
    protected migrateBuckets(stored: StoredIntegration): boolean;
    protected read(): Promise<StoreFile>;
    protected write(file: StoreFile): Promise<void>;
    /** Load the master key, generating and persisting one on first use. */
    protected masterKey(): Buffer;
    /** Encrypt → `iv:authTag:ciphertext`, all hex. */
    protected encrypt(plaintext: string): string;
    /** Decrypt an `iv:authTag:ciphertext` hex blob back to plaintext. */
    decrypt(blob: string): string;
    /** Return the decrypted secret values for a single stored integration. */
    getDecryptedSecrets(id: string): Promise<Record<string, string>>;
}
export {};
