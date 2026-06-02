/// <reference types="react" />
import * as React from '@theia/core/shared/react';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { AgentsModel } from './agents-model';
export declare const AGENTS_PANEL_ID = "commandCenter.agents-panel";
/**
 * Side-bar widget that shows the list of Command Center agents, an LLM selector, and
 * a create / edit / delete form.
 */
export declare class AgentsPanelWidget extends ReactWidget {
    static readonly ID = "commandCenter.agents-panel";
    static readonly LABEL = "Agents";
    protected readonly model: AgentsModel;
    protected init(): void;
    protected render(): React.ReactNode;
}
