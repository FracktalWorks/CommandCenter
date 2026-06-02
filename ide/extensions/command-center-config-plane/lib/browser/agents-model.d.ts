import { Emitter, Event } from '@theia/core/lib/common';
import { PreferenceService } from '@theia/core/lib/common';
import { AgentDefinition, AgentDirective, AgentDraft, AgentFeedback, ConfigPlaneService, SkillSummary, ToolDefinition } from '../common/config-plane-protocol';
import { TrustScore } from '../common/agent-intelligence';
/**
 * Shared, singleton model for the Agents panel.  Holds the list of all
 * defined agents and exposes the currently-active agent and LLM selection
 * as reactive state.
 */
export declare class AgentsModel {
    protected readonly service: ConfigPlaneService;
    protected readonly preferences: PreferenceService;
    protected readonly onDidChangeEmitter: Emitter<void>;
    readonly onDidChange: Event<void>;
    agents: AgentDefinition[];
    availableSkills: SkillSummary[];
    availableTools: ToolDefinition[];
    /** Recency-weighted trust score per agent id, populated on refresh. */
    trustScores: Record<string, TrustScore>;
    loading: boolean;
    error?: string;
    protected init(): void;
    get activeAgentId(): string;
    get currentLlm(): string;
    get availableLlms(): string[];
    refresh: () => Promise<void>;
    switchToAgent(id: string): Promise<void>;
    setCurrentLlm(modelId: string): Promise<void>;
    createAgent(draft: AgentDraft): Promise<AgentDefinition>;
    updateAgent(id: string, patch: Partial<AgentDraft>): Promise<AgentDefinition>;
    deleteAgent(id: string): Promise<void>;
    addDirective(agentId: string, text: string, source?: 'manual' | 'reflector'): Promise<AgentDirective>;
    updateDirective(agentId: string, directiveId: string, text: string): Promise<AgentDirective>;
    removeDirective(agentId: string, directiveId: string): Promise<void>;
    approveDirective(agentId: string, directiveId: string): Promise<AgentDirective>;
    rejectDirective(agentId: string, directiveId: string): Promise<AgentDirective>;
    recordFeedback(agentId: string, signal: 'positive' | 'negative', note?: string, conversationId?: string): Promise<void>;
    listFeedback(agentId: string): Promise<AgentFeedback[]>;
}
