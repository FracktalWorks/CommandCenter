import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition, ToolDraft } from '../common/config-plane-protocol';

interface StoreFile {
    version: number;
    tools: ToolDefinition[];
}

const STORE_VERSION = 1;

/**
 * Validate the relative paths of a multi-file script tool. Keys must be
 * non-empty relative POSIX-style paths that stay inside the tool's working
 * directory (no absolute paths, no `..` traversal, no reserved names).
 */
export function sanitizeToolFiles(files: Record<string, string> | undefined): void {
    if (!files) return;
    for (const rel of Object.keys(files)) {
        const key = rel.trim();
        if (!key) {
            throw new Error('Script tool file paths cannot be empty.');
        }
        const normalized = key.replace(/\\/g, '/');
        if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
            throw new Error(`Script tool file path must be relative: ${rel}`);
        }
        if (normalized.split('/').some(seg => seg === '..' || seg === '.')) {
            throw new Error(`Script tool file path must not contain '.' or '..' segments: ${rel}`);
        }
        if (normalized === 'args.json' || normalized.startsWith('main.')) {
            throw new Error(`Reserved script tool file path: ${rel} (do not use args.json or main.*; put the entry point in "code").`);
        }
    }
}

/**
 * File-backed registry of user-defined tools stored under `.command-center/`
 * next to the project root.  Tool definitions contain no secrets so the file
 * is plain JSON.  The store re-reads from disk before every operation so
 * external edits are picked up immediately.
 */
export class ToolStore {

    protected readonly dir: string;
    protected readonly storeFile: string;

    constructor(rootDir: string) {
        this.dir = path.join(rootDir, '.command-center');
        this.storeFile = path.join(this.dir, 'tools.json');
    }

    async list(): Promise<ToolDefinition[]> {
        const file = await this.read();
        return file.tools;
    }

    async create(draft: ToolDraft): Promise<ToolDefinition> {
        if (!draft.name?.trim()) {
            throw new Error('Tool name is required.');
        }
        const kind = draft.kind ?? 'http';
        if (kind === 'script') {
            if (!draft.runtime) {
                throw new Error('Script tool requires a runtime (python, node, or bash).');
            }
            if (!draft.code?.trim()) {
                throw new Error('Script tool requires code to run.');
            }
            sanitizeToolFiles(draft.files);
        } else {
            if (!draft.integrationId?.trim()) {
                throw new Error('Tool integrationId is required.');
            }
            if (!draft.path?.trim()) {
                throw new Error('Tool path is required.');
            }
        }
        const file = await this.read();
        const now = new Date().toISOString();
        const tool: ToolDefinition = {
            id: crypto.randomUUID(),
            name: draft.name.trim(),
            description: draft.description?.trim() ?? '',
            kind,
            integrationId: draft.integrationId?.trim() || undefined,
            method: kind === 'http' ? (draft.method ?? 'GET') : draft.method,
            path: draft.path?.trim() || undefined,
            params: draft.params ?? [],
            staticQueryParams: draft.staticQueryParams,
            staticBody: draft.staticBody,
            runtime: draft.runtime,
            code: draft.code,
            files: draft.files && Object.keys(draft.files).length ? draft.files : undefined,
            requirements: draft.requirements?.length ? draft.requirements : undefined,
            integrationRefs: draft.integrationRefs?.length ? draft.integrationRefs : undefined,
            timeoutMs: draft.timeoutMs,
            category: draft.category?.trim() || undefined,
            responseDescription: draft.responseDescription?.trim(),
            enabled: draft.enabled ?? true,
            createdAt: now,
            updatedAt: now,
        };
        file.tools.push(tool);
        await this.write(file);
        return tool;
    }

    async update(id: string, patch: Partial<ToolDraft>): Promise<ToolDefinition> {
        const file = await this.read();
        const tool = file.tools.find(t => t.id === id);
        if (!tool) {
            throw new Error(`Tool not found: ${id}`);
        }
        if (patch.name !== undefined) {
            const name = patch.name.trim();
            if (!name) throw new Error('Tool name cannot be empty.');
            tool.name = name;
        }
        if (patch.description !== undefined) tool.description = patch.description.trim();
        if (patch.kind !== undefined) tool.kind = patch.kind;
        if (patch.integrationId !== undefined) tool.integrationId = patch.integrationId.trim() || undefined;
        if (patch.method !== undefined) tool.method = patch.method;
        if (patch.path !== undefined) tool.path = patch.path.trim() || undefined;
        if (patch.params !== undefined) tool.params = patch.params;
        if (patch.staticQueryParams !== undefined) tool.staticQueryParams = patch.staticQueryParams;
        if (patch.staticBody !== undefined) tool.staticBody = patch.staticBody;
        if (patch.runtime !== undefined) tool.runtime = patch.runtime;
        if (patch.code !== undefined) tool.code = patch.code;
        if (patch.files !== undefined) {
            sanitizeToolFiles(patch.files);
            tool.files = Object.keys(patch.files).length ? patch.files : undefined;
        }
        if (patch.requirements !== undefined) tool.requirements = patch.requirements.length ? patch.requirements : undefined;
        if (patch.integrationRefs !== undefined) tool.integrationRefs = patch.integrationRefs.length ? patch.integrationRefs : undefined;
        if (patch.timeoutMs !== undefined) tool.timeoutMs = patch.timeoutMs;
        if (patch.category !== undefined) tool.category = patch.category.trim() || undefined;
        if (patch.responseDescription !== undefined) tool.responseDescription = patch.responseDescription.trim();
        if (patch.enabled !== undefined) tool.enabled = patch.enabled;
        tool.updatedAt = new Date().toISOString();
        await this.write(file);
        return tool;
    }

    async delete(id: string): Promise<void> {
        const file = await this.read();
        const next = file.tools.filter(t => t.id !== id);
        if (next.length === file.tools.length) {
            throw new Error(`Tool not found: ${id}`);
        }
        file.tools = next;
        await this.write(file);
    }

    // --- internals -------------------------------------------------------

    protected async read(): Promise<StoreFile> {
        try {
            const raw = await fs.promises.readFile(this.storeFile, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<StoreFile>;
            const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
            // Normalize legacy tools that predate the `kind` discriminator.
            for (const t of tools) {
                if (!t.kind) {
                    t.kind = t.code ? 'script' : 'http';
                }
            }
            return {
                version: parsed.version ?? STORE_VERSION,
                tools,
            };
        } catch {
            return { version: STORE_VERSION, tools: [] };
        }
    }

    protected async write(file: StoreFile): Promise<void> {
        await fs.promises.mkdir(this.dir, { recursive: true });
        file.version = STORE_VERSION;
        const tmp = `${this.storeFile}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(file, undefined, 2), 'utf-8');
        await fs.promises.rename(tmp, this.storeFile);
    }
}
