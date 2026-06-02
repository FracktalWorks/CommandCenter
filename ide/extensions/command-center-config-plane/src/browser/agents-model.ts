import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common';
import { PreferenceChange, PreferenceScope, PreferenceService } from '@theia/core/lib/common';
import {
    AgentDefinition,
    AgentDirective,
    AgentDraft,
    AgentFeedback,
    ConfigPlaneService,
    SkillSummary,
    ToolDefinition,
} from '../common/config-plane-protocol';
import { TrustScore } from '../common/agent-intelligence';

/**
 * Shared, singleton model for the Agents panel.  Holds the list of all
 * defined agents and exposes the currently-active agent and LLM selection
 * as reactive state.
 */
@injectable()
export class AgentsModel {

    @inject(ConfigPlaneService)
    protected readonly service: ConfigPlaneService;

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    agents: AgentDefinition[] = [];
    availableSkills: SkillSummary[] = [];
    availableTools: ToolDefinition[] = [];
    /** Recency-weighted trust score per agent id, populated on refresh. */
    trustScores: Record<string, TrustScore> = {};
    loading = false;
    error?: string;

    @postConstruct()
    protected init(): void {
        this.preferences.ready.then(() => {
            this.refresh();
        });
        this.preferences.onPreferenceChanged((e: PreferenceChange) => {
            if (
                e.preferenceName === 'ai-features.chat.defaultChatAgent' ||
                e.preferenceName === 'ai-features.openAiCustom.customOpenAiModels' ||
                e.preferenceName === 'ai-features.languageModelAliases'
            ) {
                this.onDidChangeEmitter.fire();
            }
        });
    }

    // -----------------------------------------------------------------------
    // Computed properties (read preferences live)
    // -----------------------------------------------------------------------

    get activeAgentId(): string {
        return (this.preferences.get('ai-features.chat.defaultChatAgent') as string | undefined) ?? 'assistant';
    }

    get currentLlm(): string {
        const aliases = (this.preferences.get('ai-features.languageModelAliases') as
            Record<string, { selectedModel: string }> | undefined) ?? {};
        return aliases['default/universal']?.selectedModel ?? '';
    }

    get availableLlms(): string[] {
        const models = (this.preferences.get('ai-features.openAiCustom.customOpenAiModels') as
            Array<{ id: string }> | undefined) ?? [];
        return models.map(m => m.id);
    }

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------

    refresh = async (): Promise<void> => {
        this.loading = true;
        this.error = undefined;
        this.onDidChangeEmitter.fire();
        try {
            this.agents = await this.service.listAgents();
            this.availableSkills = await this.service.listSkills().catch(() => []);
            this.availableTools = await this.service.listTools().catch(() => []);
            // Load trust scores in parallel; failures fall back to neutral.
            const scores = await Promise.all(
                this.agents.map(a => this.service.getAgentTrust(a.id).catch(() => undefined)),
            );
            const next: Record<string, TrustScore> = {};
            this.agents.forEach((a, i) => {
                const s = scores[i];
                if (s) { next[a.id] = s; }
            });
            this.trustScores = next;
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
        } finally {
            this.loading = false;
            this.onDidChangeEmitter.fire();
        }
    };

    async switchToAgent(id: string): Promise<void> {
        await this.preferences.set('ai-features.chat.defaultChatAgent', id, PreferenceScope.User);
    }

    async setCurrentLlm(modelId: string): Promise<void> {
        const current = (this.preferences.get('ai-features.languageModelAliases') as
            Record<string, unknown> | undefined) ?? {};
        await this.preferences.set('ai-features.languageModelAliases', {
            ...current,
            'default/fast':            { selectedModel: modelId },
            'default/universal':       { selectedModel: modelId },
            'default/code':            { selectedModel: modelId },
            'default/summarize':       { selectedModel: modelId },
            'default/code-completion': { selectedModel: modelId },
        }, PreferenceScope.User);
    }

    async createAgent(draft: AgentDraft): Promise<AgentDefinition> {
        const agent = await this.service.createAgent(draft);
        await this.refresh();
        return agent;
    }

    async updateAgent(id: string, patch: Partial<AgentDraft>): Promise<AgentDefinition> {
        const agent = await this.service.updateAgent(id, patch);
        await this.refresh();
        return agent;
    }

    async deleteAgent(id: string): Promise<void> {
        await this.service.deleteAgent(id);
        await this.refresh();
    }

    // --- Directive management -------------------------------------------

    async addDirective(agentId: string, text: string, source: 'manual' | 'reflector' = 'manual'): Promise<AgentDirective> {
        const d = await this.service.addDirective(agentId, text, source);
        await this.refresh();
        return d;
    }

    async updateDirective(agentId: string, directiveId: string, text: string): Promise<AgentDirective> {
        const d = await this.service.updateDirective(agentId, directiveId, text);
        await this.refresh();
        return d;
    }

    async removeDirective(agentId: string, directiveId: string): Promise<void> {
        await this.service.removeDirective(agentId, directiveId);
        await this.refresh();
    }

    async approveDirective(agentId: string, directiveId: string): Promise<AgentDirective> {
        const d = await this.service.approveDirective(agentId, directiveId);
        await this.refresh();
        return d;
    }

    async rejectDirective(agentId: string, directiveId: string): Promise<AgentDirective> {
        const d = await this.service.rejectDirective(agentId, directiveId);
        await this.refresh();
        return d;
    }

    // --- Feedback -------------------------------------------------------

    async recordFeedback(agentId: string, signal: 'positive' | 'negative', note?: string, conversationId?: string): Promise<void> {
        await this.service.recordFeedback(agentId, signal, note, conversationId);
    }

    async listFeedback(agentId: string): Promise<AgentFeedback[]> {
        return this.service.listFeedback(agentId);
    }
}
