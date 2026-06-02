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
exports.ToolStore = exports.sanitizeToolFiles = void 0;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const STORE_VERSION = 1;
/**
 * Validate the relative paths of a multi-file script tool. Keys must be
 * non-empty relative POSIX-style paths that stay inside the tool's working
 * directory (no absolute paths, no `..` traversal, no reserved names).
 */
function sanitizeToolFiles(files) {
    if (!files)
        return;
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
exports.sanitizeToolFiles = sanitizeToolFiles;
/**
 * File-backed registry of user-defined tools stored under `.command-center/`
 * next to the project root.  Tool definitions contain no secrets so the file
 * is plain JSON.  The store re-reads from disk before every operation so
 * external edits are picked up immediately.
 */
class ToolStore {
    constructor(rootDir) {
        this.dir = path.join(rootDir, '.command-center');
        this.storeFile = path.join(this.dir, 'tools.json');
    }
    async list() {
        const file = await this.read();
        return file.tools;
    }
    async create(draft) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
        if (!((_a = draft.name) === null || _a === void 0 ? void 0 : _a.trim())) {
            throw new Error('Tool name is required.');
        }
        const kind = (_b = draft.kind) !== null && _b !== void 0 ? _b : 'http';
        if (kind === 'script') {
            if (!draft.runtime) {
                throw new Error('Script tool requires a runtime (python, node, or bash).');
            }
            if (!((_c = draft.code) === null || _c === void 0 ? void 0 : _c.trim())) {
                throw new Error('Script tool requires code to run.');
            }
            sanitizeToolFiles(draft.files);
        }
        else {
            if (!((_d = draft.integrationId) === null || _d === void 0 ? void 0 : _d.trim())) {
                throw new Error('Tool integrationId is required.');
            }
            if (!((_e = draft.path) === null || _e === void 0 ? void 0 : _e.trim())) {
                throw new Error('Tool path is required.');
            }
        }
        const file = await this.read();
        const now = new Date().toISOString();
        const tool = {
            id: crypto.randomUUID(),
            name: draft.name.trim(),
            description: (_g = (_f = draft.description) === null || _f === void 0 ? void 0 : _f.trim()) !== null && _g !== void 0 ? _g : '',
            kind,
            integrationId: ((_h = draft.integrationId) === null || _h === void 0 ? void 0 : _h.trim()) || undefined,
            method: kind === 'http' ? ((_j = draft.method) !== null && _j !== void 0 ? _j : 'GET') : draft.method,
            path: ((_k = draft.path) === null || _k === void 0 ? void 0 : _k.trim()) || undefined,
            params: (_l = draft.params) !== null && _l !== void 0 ? _l : [],
            staticQueryParams: draft.staticQueryParams,
            staticBody: draft.staticBody,
            runtime: draft.runtime,
            code: draft.code,
            files: draft.files && Object.keys(draft.files).length ? draft.files : undefined,
            requirements: ((_m = draft.requirements) === null || _m === void 0 ? void 0 : _m.length) ? draft.requirements : undefined,
            integrationRefs: ((_o = draft.integrationRefs) === null || _o === void 0 ? void 0 : _o.length) ? draft.integrationRefs : undefined,
            timeoutMs: draft.timeoutMs,
            category: ((_p = draft.category) === null || _p === void 0 ? void 0 : _p.trim()) || undefined,
            responseDescription: (_q = draft.responseDescription) === null || _q === void 0 ? void 0 : _q.trim(),
            enabled: (_r = draft.enabled) !== null && _r !== void 0 ? _r : true,
            createdAt: now,
            updatedAt: now,
        };
        file.tools.push(tool);
        await this.write(file);
        return tool;
    }
    async update(id, patch) {
        const file = await this.read();
        const tool = file.tools.find(t => t.id === id);
        if (!tool) {
            throw new Error(`Tool not found: ${id}`);
        }
        if (patch.name !== undefined) {
            const name = patch.name.trim();
            if (!name)
                throw new Error('Tool name cannot be empty.');
            tool.name = name;
        }
        if (patch.description !== undefined)
            tool.description = patch.description.trim();
        if (patch.kind !== undefined)
            tool.kind = patch.kind;
        if (patch.integrationId !== undefined)
            tool.integrationId = patch.integrationId.trim() || undefined;
        if (patch.method !== undefined)
            tool.method = patch.method;
        if (patch.path !== undefined)
            tool.path = patch.path.trim() || undefined;
        if (patch.params !== undefined)
            tool.params = patch.params;
        if (patch.staticQueryParams !== undefined)
            tool.staticQueryParams = patch.staticQueryParams;
        if (patch.staticBody !== undefined)
            tool.staticBody = patch.staticBody;
        if (patch.runtime !== undefined)
            tool.runtime = patch.runtime;
        if (patch.code !== undefined)
            tool.code = patch.code;
        if (patch.files !== undefined) {
            sanitizeToolFiles(patch.files);
            tool.files = Object.keys(patch.files).length ? patch.files : undefined;
        }
        if (patch.requirements !== undefined)
            tool.requirements = patch.requirements.length ? patch.requirements : undefined;
        if (patch.integrationRefs !== undefined)
            tool.integrationRefs = patch.integrationRefs.length ? patch.integrationRefs : undefined;
        if (patch.timeoutMs !== undefined)
            tool.timeoutMs = patch.timeoutMs;
        if (patch.category !== undefined)
            tool.category = patch.category.trim() || undefined;
        if (patch.responseDescription !== undefined)
            tool.responseDescription = patch.responseDescription.trim();
        if (patch.enabled !== undefined)
            tool.enabled = patch.enabled;
        tool.updatedAt = new Date().toISOString();
        await this.write(file);
        return tool;
    }
    async delete(id) {
        const file = await this.read();
        const next = file.tools.filter(t => t.id !== id);
        if (next.length === file.tools.length) {
            throw new Error(`Tool not found: ${id}`);
        }
        file.tools = next;
        await this.write(file);
    }
    // --- internals -------------------------------------------------------
    async read() {
        var _a;
        try {
            const raw = await fs.promises.readFile(this.storeFile, 'utf-8');
            const parsed = JSON.parse(raw);
            const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
            // Normalize legacy tools that predate the `kind` discriminator.
            for (const t of tools) {
                if (!t.kind) {
                    t.kind = t.code ? 'script' : 'http';
                }
            }
            return {
                version: (_a = parsed.version) !== null && _a !== void 0 ? _a : STORE_VERSION,
                tools,
            };
        }
        catch {
            return { version: STORE_VERSION, tools: [] };
        }
    }
    async write(file) {
        await fs.promises.mkdir(this.dir, { recursive: true });
        file.version = STORE_VERSION;
        const tmp = `${this.storeFile}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(file, undefined, 2), 'utf-8');
        await fs.promises.rename(tmp, this.storeFile);
    }
}
exports.ToolStore = ToolStore;
//# sourceMappingURL=tool-store.js.map