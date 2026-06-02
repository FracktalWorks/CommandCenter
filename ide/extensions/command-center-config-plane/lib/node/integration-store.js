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
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationStore = void 0;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const integration_specs_1 = require("./integration-specs");
const STORE_VERSION = 1;
const AES_ALGO = 'aes-256-gcm';
/**
 * File-backed registry of integrations, stored under `.command-center/` next to
 * the project root. Secret field values are encrypted at rest with AES-256-GCM
 * using a locally generated master key. The plaintext JSON manifest (minus
 * secrets) is human- and agent-editable; the store always re-reads from disk
 * before each operation so external edits are picked up.
 */
class IntegrationStore {
    constructor(rootDir) {
        this.dir = path.join(rootDir, '.command-center');
        // Migrate the legacy `.jannet` storage directory to `.command-center`
        // so existing integrations and secrets survive the rebrand.
        const legacyDir = path.join(rootDir, '.jannet');
        try {
            if (!fs.existsSync(this.dir) && fs.existsSync(legacyDir)) {
                fs.renameSync(legacyDir, this.dir);
            }
        }
        catch {
            // Best-effort migration; fall through and use the new directory.
        }
        this.storeFile = path.join(this.dir, 'integrations.json');
        this.keyFile = path.join(this.dir, 'secret.key');
    }
    async list() {
        const file = await this.read();
        return file.integrations.map(i => this.toRecord(i));
    }
    async create(draft) {
        var _a, _b;
        this.validateKind(draft.kind);
        if (!draft.name || !draft.name.trim()) {
            throw new Error('Integration name is required.');
        }
        const file = await this.read();
        const now = new Date().toISOString();
        const routed = this.routeBuckets(draft.kind, draft.values, draft.secrets);
        const stored = {
            id: crypto.randomUUID(),
            kind: draft.kind,
            name: draft.name.trim(),
            description: ((_a = draft.description) === null || _a === void 0 ? void 0 : _a.trim()) || undefined,
            enabled: (_b = draft.enabled) !== null && _b !== void 0 ? _b : true,
            values: routed.values,
            secrets: this.encryptMap(routed.secretsPlain),
            createdAt: now,
            updatedAt: now
        };
        file.integrations.push(stored);
        await this.write(file);
        return this.toRecord(stored);
    }
    async update(id, patch) {
        const file = await this.read();
        const stored = file.integrations.find(i => i.id === id);
        if (!stored) {
            throw new Error(`Integration not found: ${id}`);
        }
        if (patch.name !== undefined) {
            const name = patch.name.trim();
            if (!name) {
                throw new Error('Integration name cannot be empty.');
            }
            stored.name = name;
        }
        if (patch.description !== undefined) {
            stored.description = patch.description.trim() || undefined;
        }
        if (patch.enabled !== undefined) {
            stored.enabled = patch.enabled;
        }
        if (patch.values !== undefined || patch.secrets !== undefined) {
            const { secret, nonSecret } = this.fieldKeys(stored.kind);
            // Replace the non-secret value set when `values` is provided. Any
            // secret-typed key mistakenly sent under `values` is routed to secrets.
            if (patch.values !== undefined) {
                const newValues = {};
                for (const [key, raw] of Object.entries(patch.values)) {
                    if (raw === undefined) {
                        continue;
                    }
                    const value = String(raw);
                    if (nonSecret.has(key)) {
                        if (value !== '') {
                            newValues[key] = value;
                        }
                    }
                    else if (secret.has(key)) {
                        if (value === '') {
                            delete stored.secrets[key];
                        }
                        else {
                            stored.secrets[key] = this.encrypt(value);
                        }
                    }
                }
                stored.values = newValues;
            }
            // Merge secrets: empty string clears, undefined skips. A non-secret
            // field (e.g. clientId) mistakenly sent under `secrets` is routed to
            // values so OAuth and other flows find it where they expect it.
            if (patch.secrets !== undefined) {
                for (const [key, value] of Object.entries(patch.secrets)) {
                    if (value === undefined) {
                        continue;
                    }
                    if (secret.has(key)) {
                        if (value === '') {
                            delete stored.secrets[key];
                        }
                        else {
                            stored.secrets[key] = this.encrypt(value);
                        }
                    }
                    else if (nonSecret.has(key)) {
                        if (value === '') {
                            delete stored.values[key];
                        }
                        else {
                            stored.values[key] = String(value);
                        }
                    }
                }
            }
        }
        stored.updatedAt = new Date().toISOString();
        await this.write(file);
        return this.toRecord(stored);
    }
    async setEnabled(id, enabled) {
        return this.update(id, { enabled });
    }
    async delete(id) {
        const file = await this.read();
        const next = file.integrations.filter(i => i.id !== id);
        if (next.length === file.integrations.length) {
            throw new Error(`Integration not found: ${id}`);
        }
        file.integrations = next;
        await this.write(file);
    }
    // --- internals -------------------------------------------------------
    toRecord(stored) {
        return {
            id: stored.id,
            kind: stored.kind,
            name: stored.name,
            description: stored.description,
            enabled: stored.enabled,
            values: { ...stored.values },
            secretsSet: Object.keys(stored.secrets).filter(k => !!stored.secrets[k]),
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt
        };
    }
    validateKind(kind) {
        if (!integration_specs_1.INTEGRATION_KIND_SPECS.some(s => s.kind === kind)) {
            throw new Error(`Unknown integration kind: ${kind}`);
        }
    }
    /** Secret vs non-secret declared field keys for a kind. */
    fieldKeys(kind) {
        var _a, _b;
        const spec = integration_specs_1.INTEGRATION_KIND_SPECS.find(s => s.kind === kind);
        const secret = new Set(((_a = spec === null || spec === void 0 ? void 0 : spec.fields) !== null && _a !== void 0 ? _a : []).filter(f => f.type === 'secret').map(f => f.key));
        const nonSecret = new Set(((_b = spec === null || spec === void 0 ? void 0 : spec.fields) !== null && _b !== void 0 ? _b : []).filter(f => f.type !== 'secret').map(f => f.key));
        return { secret, nonSecret };
    }
    /**
     * Route a combined set of provided values + secrets into the correct buckets
     * by declared field type, regardless of which bucket the caller used. Secret
     * fields go to `secretsPlain` (plaintext, for the caller to encrypt); every
     * other declared field goes to `values`. This makes the store tolerant of
     * callers (e.g. chat agents) that put a non-secret field like `clientId`
     * under `secrets`, or a secret under `values`. Unknown keys are dropped.
     */
    routeBuckets(kind, values, secrets) {
        const { secret, nonSecret } = this.fieldKeys(kind);
        const outValues = {};
        const outSecrets = {};
        const merged = { ...(values !== null && values !== void 0 ? values : {}), ...(secrets !== null && secrets !== void 0 ? secrets : {}) };
        for (const [key, raw] of Object.entries(merged)) {
            if (raw === undefined) {
                continue;
            }
            const value = String(raw);
            if (secret.has(key)) {
                if (value) {
                    outSecrets[key] = value;
                }
            }
            else if (nonSecret.has(key)) {
                if (value !== '') {
                    outValues[key] = value;
                }
            }
            // keys not declared on the kind are ignored
        }
        return { values: outValues, secretsPlain: outSecrets };
    }
    /** Encrypt each plaintext value in a map, skipping empties. */
    encryptMap(plain) {
        const out = {};
        for (const [key, value] of Object.entries(plain)) {
            if (value) {
                out[key] = this.encrypt(value);
            }
        }
        return out;
    }
    /**
     * Re-route any persisted field sitting in the wrong bucket into the correct
     * one, based on the kind's schema: a non-secret field stored (encrypted)
     * under `secrets` is decrypted back into `values`, and a secret field stored
     * in plaintext `values` is encrypted into `secrets`. Fixes records written
     * before bucket routing existed (e.g. an OAuth `clientId` saved as a secret).
     * Mutates `stored` in place; returns true when anything moved.
     */
    migrateBuckets(stored) {
        var _a, _b;
        if (!stored || typeof stored !== 'object') {
            return false;
        }
        stored.values = (_a = stored.values) !== null && _a !== void 0 ? _a : {};
        stored.secrets = (_b = stored.secrets) !== null && _b !== void 0 ? _b : {};
        const { secret, nonSecret } = this.fieldKeys(stored.kind);
        let changed = false;
        for (const key of Object.keys(stored.secrets)) {
            if (nonSecret.has(key)) {
                let plain;
                try {
                    plain = this.decrypt(stored.secrets[key]);
                }
                catch {
                    plain = stored.secrets[key];
                }
                stored.values[key] = plain;
                delete stored.secrets[key];
                changed = true;
            }
        }
        for (const key of Object.keys(stored.values)) {
            if (secret.has(key)) {
                stored.secrets[key] = this.encrypt(stored.values[key]);
                delete stored.values[key];
                changed = true;
            }
        }
        return changed;
    }
    async read() {
        var _a;
        try {
            const raw = await fs.promises.readFile(this.storeFile, 'utf-8');
            const parsed = JSON.parse(raw);
            const integrations = Array.isArray(parsed.integrations) ? parsed.integrations : [];
            for (const integration of integrations) {
                this.migrateBuckets(integration);
            }
            return {
                version: (_a = parsed.version) !== null && _a !== void 0 ? _a : STORE_VERSION,
                integrations
            };
        }
        catch {
            return { version: STORE_VERSION, integrations: [] };
        }
    }
    async write(file) {
        await fs.promises.mkdir(this.dir, { recursive: true });
        file.version = STORE_VERSION;
        const tmp = `${this.storeFile}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(file, undefined, 2), 'utf-8');
        await fs.promises.rename(tmp, this.storeFile);
    }
    // --- crypto ----------------------------------------------------------
    /** Load the master key, generating and persisting one on first use. */
    masterKey() {
        try {
            const hex = fs.readFileSync(this.keyFile, 'utf-8').trim();
            const buf = Buffer.from(hex, 'hex');
            if (buf.length === 32) {
                return buf;
            }
        }
        catch {
            // fall through to generation
        }
        const key = crypto.randomBytes(32);
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.keyFile, key.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
        try {
            fs.chmodSync(this.keyFile, 0o600);
        }
        catch {
            // best-effort on platforms without POSIX perms
        }
        return key;
    }
    /** Encrypt → `iv:authTag:ciphertext`, all hex. */
    encrypt(plaintext) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(AES_ALGO, this.masterKey(), iv);
        const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    }
    /** Decrypt an `iv:authTag:ciphertext` hex blob back to plaintext. */
    decrypt(blob) {
        const parts = blob.split(':');
        if (parts.length !== 3)
            throw new Error('Invalid encrypted blob format');
        const iv = Buffer.from(parts[0], 'hex');
        const tag = Buffer.from(parts[1], 'hex');
        const enc = Buffer.from(parts[2], 'hex');
        const decipher = crypto.createDecipheriv(AES_ALGO, this.masterKey(), iv);
        decipher.setAuthTag(tag);
        return decipher.update(enc).toString('utf-8') + decipher.final('utf-8');
    }
    /** Return the decrypted secret values for a single stored integration. */
    async getDecryptedSecrets(id) {
        const file = await this.read();
        const stored = file.integrations.find(i => i.id === id);
        if (!stored)
            return {};
        const out = {};
        for (const [key, enc] of Object.entries(stored.secrets)) {
            try {
                out[key] = this.decrypt(enc);
            }
            catch { /* skip corrupt */ }
        }
        return out;
    }
}
exports.IntegrationStore = IntegrationStore;
//# sourceMappingURL=integration-store.js.map