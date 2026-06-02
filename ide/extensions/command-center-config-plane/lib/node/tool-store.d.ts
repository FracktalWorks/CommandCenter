import { ToolDefinition, ToolDraft } from '../common/config-plane-protocol';
interface StoreFile {
    version: number;
    tools: ToolDefinition[];
}
/**
 * Validate the relative paths of a multi-file script tool. Keys must be
 * non-empty relative POSIX-style paths that stay inside the tool's working
 * directory (no absolute paths, no `..` traversal, no reserved names).
 */
export declare function sanitizeToolFiles(files: Record<string, string> | undefined): void;
/**
 * File-backed registry of user-defined tools stored under `.command-center/`
 * next to the project root.  Tool definitions contain no secrets so the file
 * is plain JSON.  The store re-reads from disk before every operation so
 * external edits are picked up immediately.
 */
export declare class ToolStore {
    protected readonly dir: string;
    protected readonly storeFile: string;
    constructor(rootDir: string);
    list(): Promise<ToolDefinition[]>;
    create(draft: ToolDraft): Promise<ToolDefinition>;
    update(id: string, patch: Partial<ToolDraft>): Promise<ToolDefinition>;
    delete(id: string): Promise<void>;
    protected read(): Promise<StoreFile>;
    protected write(file: StoreFile): Promise<void>;
}
export {};
