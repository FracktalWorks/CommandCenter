/// <reference types="react" />
import * as React from '@theia/core/shared/react';
import { AIChatInputWidget } from '@theia/ai-chat-ui/lib/browser/chat-input-widget';
import { ChatAgent } from '@theia/ai-chat';
import { ConfigPlaneService } from '../common/config-plane-protocol';
export declare class CommandCenterChatInputWidget extends AIChatInputWidget {
    protected readonly configPlane: ConfigPlaneService;
    /** Tracks what feedback signal was last sent for the current session. */
    protected lastFeedbackSignal: 'positive' | 'negative' | undefined;
    /** Agent ids hidden from the picker (definitions with showInChat=false, e.g. Reflector). */
    protected hiddenAgentIds: Set<string>;
    protected ccListenersBound: boolean;
    protected init(): void;
    /**
     * Load the set of agent ids that should be hidden from the chat picker.
     * These are registered in customAgents.yml (so they can be switched to
     * programmatically) but carry `showInChat: false` in their definition —
     * e.g. the Reflector meta-agent.
     */
    protected refreshHiddenAgents(): Promise<void>;
    /** Re-render the selector bar when models, agents or the session change. */
    protected bindCcListeners(): void;
    protected get availableModels(): string[];
    protected get currentModel(): string;
    protected setModel(modelId: string): Promise<void>;
    protected get chatAgents(): ChatAgent[];
    protected get currentAgentId(): string | undefined;
    /** Switch the receiving agent for the current session on the fly. */
    protected setAgent(agentId: string): Promise<void>;
    protected render(): React.ReactNode;
    protected renderSelectorBar(): React.ReactNode;
    protected sendFeedback(signal: 'positive' | 'negative'): Promise<void>;
}
