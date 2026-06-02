/// <reference types="react" />
import * as React from '@theia/core/shared/react';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ToolDefinition, ToolKind, ToolParamSpec, ToolRuntime } from '../common/config-plane-protocol';
import { ToolsModel } from './tools-model';
interface ToolFormState {
    name: string;
    description: string;
    kind: ToolKind;
    integrationId: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    runtime: ToolRuntime;
    code: string;
    files: Array<{
        path: string;
        content: string;
    }>;
    requirements: string;
    integrationRefs: string[];
    timeoutMs: string;
    category: string;
    params: ToolParamSpec[];
    responseDescription: string;
    enabled: boolean;
}
export declare class ToolsPanelWidget extends ReactWidget {
    static readonly ID = "commandCenter.tools-panel";
    protected readonly model: ToolsModel;
    /** null = list view; 'new' = create form; string = edit id */
    protected formId?: string | null;
    protected formState: ToolFormState;
    protected formError?: string;
    protected saving: boolean;
    /** List-view search query and the set of collapsed category groups. */
    protected searchQuery: string;
    protected collapsedGroups: Set<string>;
    protected init(): void;
    protected render(): React.ReactNode;
    protected renderList(): React.ReactNode;
    /** Search box + tools grouped into collapsible category subsections. */
    protected renderGroupedTools(): React.ReactNode;
    protected toggleGroup: (label: string) => void;
    protected renderForm(): React.ReactNode;
    protected openCreate: () => void;
    protected openEdit: (tool: ToolDefinition) => void;
    protected closeForm: () => void;
    protected save: () => Promise<void>;
    protected confirmDelete: (tool: ToolDefinition) => Promise<void>;
}
export {};
