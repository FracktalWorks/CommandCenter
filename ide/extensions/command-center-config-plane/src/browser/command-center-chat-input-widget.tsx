// *****************************************************************************
// Command Center custom chat input widget.
//
// Extends Theia's AIChatInputWidget to surface a model picker and an agent
// picker directly inside the chat input box (Copilot / Claude-Code style),
// rather than in the separate Agents side panel. The agent picker switches the
// receiving agent on the fly within the current chat session by setting the
// session's pinned agent.
// *****************************************************************************

import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { PreferenceScope } from '@theia/core/lib/common';
import { AIChatInputWidget } from '@theia/ai-chat-ui/lib/browser/chat-input-widget';
import { ChatAgent, ChatAgentLocation } from '@theia/ai-chat';
import { ConfigPlaneService } from '../common/config-plane-protocol';

/** Preference holding the per-alias model selection. */
const ALIASES_PREF = 'ai-features.languageModelAliases';
/** Preference holding the list of configured custom OpenAI-compat models (may be empty). */
const OPENAI_MODELS_PREF = 'ai-features.openAiCustom.customOpenAiModels';
/** Preference holding the bare model ids for the native Google provider. */
const GOOGLE_MODELS_PREF = 'ai-features.google.models';
/** Preference holding the default chat agent id. */
const DEFAULT_AGENT_PREF = 'ai-features.chat.defaultChatAgent';

/** The aliases whose selected model we keep in sync from the picker. */
const SYNCED_ALIASES = [
    'default/fast',
    'default/universal',
    'default/code',
    'default/summarize',
    'default/code-completion',
];

/** Human-readable label for a model id. */
function modelLabel(id: string): string {
    return id
        .replace('gemini-', 'Gemini ')
        .replace('-flash-preview', ' Flash Preview')
        .replace('-flash', ' Flash')
        .replace('-pro-preview', ' Pro Preview')
        .replace('-pro', ' Pro');
}

@injectable()
export class CommandCenterChatInputWidget extends AIChatInputWidget {

    @inject(ConfigPlaneService)
    protected readonly configPlane: ConfigPlaneService;

    /** Tracks what feedback signal was last sent for the current session. */
    protected lastFeedbackSignal: 'positive' | 'negative' | undefined;

    /** Agent ids hidden from the picker (definitions with showInChat=false, e.g. Reflector). */
    protected hiddenAgentIds = new Set<string>();

    protected ccListenersBound = false;

    protected init(): void {
        super.init();
        this.bindCcListeners();
        this.refreshHiddenAgents();
    }

    /**
     * Load the set of agent ids that should be hidden from the chat picker.
     * These are registered in customAgents.yml (so they can be switched to
     * programmatically) but carry `showInChat: false` in their definition —
     * e.g. the Reflector meta-agent.
     */
    protected async refreshHiddenAgents(): Promise<void> {
        try {
            const agents = await this.configPlane.listAgents();
            this.hiddenAgentIds = new Set(agents.filter(a => a.showInChat === false).map(a => a.id));
            this.update();
        } catch {
            /* leave previous set in place on error */
        }
    }

    /** Re-render the selector bar when models, agents or the session change. */
    protected bindCcListeners(): void {
        if (this.ccListenersBound) {
            return;
        }
        this.ccListenersBound = true;

        const prefs = this.preferenceService;
        if (prefs) {
            this.toDispose.push(prefs.onPreferenceChanged(e => {
                if (
                    e.preferenceName === ALIASES_PREF ||
                    e.preferenceName === OPENAI_MODELS_PREF ||
                    e.preferenceName === GOOGLE_MODELS_PREF ||
                    e.preferenceName === DEFAULT_AGENT_PREF
                ) {
                    this.update();
                }
            }));
        }
        this.toDispose.push(this.chatAgentService.onDidChangeAgents(() => {
            this.refreshHiddenAgents();
            this.update();
        }));
        this.toDispose.push(this.chatService.onSessionEvent(() => this.update()));
    }

    // --- Model selection -------------------------------------------------

    protected get availableModels(): string[] {
        // Native Google provider: bare ids like 'gemini-2.5-flash' stored in
        // GOOGLE_MODELS_PREF; registered with a 'google/' prefix.
        const googleBareIds = (this.preferenceService?.get(GOOGLE_MODELS_PREF) as string[] | undefined) ?? [];
        const googleIds = googleBareIds.map(id => `google/${id}`);

        // Custom OpenAI-compat models (may be empty when only Google is used).
        const openaiModels = (this.preferenceService?.get(OPENAI_MODELS_PREF) as Array<{ id: string }> | undefined) ?? [];
        const openaiIds = openaiModels.map(m => m.id).filter(Boolean);

        // Deduplicate; Google models first.
        return [...new Set([...googleIds, ...openaiIds])];
    }

    protected get currentModel(): string {
        const aliases = (this.preferenceService?.get(ALIASES_PREF) as
            Record<string, { selectedModel?: string }> | undefined) ?? {};
        return aliases['default/universal']?.selectedModel ?? '';
    }

    protected async setModel(modelId: string): Promise<void> {
        const current = (this.preferenceService?.get(ALIASES_PREF) as
            Record<string, unknown> | undefined) ?? {};
        const next: Record<string, unknown> = { ...current };
        for (const alias of SYNCED_ALIASES) {
            next[alias] = { selectedModel: modelId };
        }
        await this.preferenceService?.set(ALIASES_PREF, next, PreferenceScope.User);
    }

    // --- Agent selection -------------------------------------------------

    protected get chatAgents(): ChatAgent[] {
        return this.chatAgentService.getAgents().filter(a =>
            !this.hiddenAgentIds.has(a.id) &&
            (!a.locations || a.locations.length === 0 || a.locations.includes(ChatAgentLocation.Panel))
        );
    }

    protected get currentAgentId(): string | undefined {
        const active = this.chatService.getActiveSession();
        if (active?.pinnedAgent) {
            return active.pinnedAgent.id;
        }
        return this.receivingAgent?.agentId
            ?? (this.preferenceService?.get(DEFAULT_AGENT_PREF) as string | undefined);
    }

    /** Switch the receiving agent for the current session on the fly. */
    protected async setAgent(agentId: string): Promise<void> {
        const agent = this.chatAgentService.getAgent(agentId);
        if (!agent) {
            return;
        }
        const active = this.chatService.getActiveSession();
        if (active) {
            active.pinnedAgent = agent;
        }
        this.pinnedAgent = agent;
        await this.preferenceService?.set(DEFAULT_AGENT_PREF, agentId, PreferenceScope.User);
        this.scheduleUpdateReceivingAgent();
        this.update();
    }

    // --- Rendering -------------------------------------------------------

    protected render(): React.ReactNode {
        return (
            <div className='command-center-chat-input-wrapper' style={{ display: 'flex', flexDirection: 'column', alignSelf: 'stretch', width: '100%', overflow: 'hidden' }}>
                {super.render()}
                {this.renderSelectorBar()}
            </div>
        );
    }

    protected renderSelectorBar(): React.ReactNode {
        const models = this.availableModels;
        const agents = this.chatAgents;
        const currentModel = this.currentModel;
        const currentAgentId = this.currentAgentId;

        const currentAgentName = agents.find(a => a.id === currentAgentId)?.name ?? 'Select agent…';
        const currentModelLabel = currentModel ? modelLabel(currentModel) : 'Select model…';

        // Shared font / spacing for all picker items
        const ITEM_FONT: React.CSSProperties = {
            fontSize: '0.78em',
            whiteSpace: 'nowrap',
        };

        const renderSelect = (
            label: string,
            iconClass: string,
            displayText: string,
            value: string,
            options: Array<{ value: string; label: string }>,
            onChange: (v: string) => void,
        ): React.ReactNode => (
            <label
                style={{ display: 'flex', alignItems: 'center', gap: '4px', opacity: 0.85 }}
                title={label}
            >
                <span
                    className={`codicon ${iconClass}`}
                    style={{ fontSize: '14px', lineHeight: '14px', width: '14px', height: '14px', flex: '0 0 auto', opacity: 0.7 }}
                />
                {/* Wrapper: sized by the visible text span — NOT the select element */}
                <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                    {/* Visible display: rendered by span so no clipping */}
                    <span style={{
                        ...ITEM_FONT,
                        padding: '1px 18px 1px 6px',
                        background: 'var(--theia-input-background)',
                        color: 'var(--theia-input-foreground)',
                        border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
                        borderRadius: '4px',
                        pointerEvents: 'none',
                        userSelect: 'none',
                    }}>{displayText}</span>
                    {/* ▾ arrow overlay */}
                    <span style={{
                        position: 'absolute',
                        right: '4px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        pointerEvents: 'none',
                        fontSize: '9px',
                        opacity: 0.6,
                        lineHeight: 1,
                        color: 'var(--theia-input-foreground)',
                    }}>▾</span>
                    {/* Transparent select on top — provides the native dropdown behaviour */}
                    <select
                        style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            opacity: 0,
                            cursor: 'pointer',
                        }}
                        value={value}
                        onChange={e => onChange(e.target.value)}
                    >
                        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                </div>
            </label>
        );

        return (
            <div
                className='command-center-chat-selector-bar'
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '3px 8px 4px',
                    flexWrap: 'wrap',
                }}
            >
                {agents.length > 0 && renderSelect(
                    'Agent that will answer in this chat',
                    'codicon-hubot',
                    currentAgentName,
                    currentAgentId ?? '',
                    [
                        ...(!currentAgentId ? [{ value: '', label: 'Select agent…' }] : []),
                        ...agents.map(a => ({ value: a.id, label: a.name })),
                    ],
                    v => this.setAgent(v),
                )}
                {models.length > 0 && renderSelect(
                    'Model used for this chat',
                    'codicon-symbol-enum',
                    currentModelLabel,
                    currentModel ?? '',
                    [
                        ...(!currentModel ? [{ value: '', label: 'Select model…' }] : []),
                        ...models.map(id => ({ value: id, label: modelLabel(id) })),
                    ],
                    v => this.setModel(v),
                )}
                {/* Feedback thumbs — rate the last response */}
                <div style={{ display: 'flex', gap: '2px', marginLeft: 'auto' }}>
                    {(['positive', 'negative'] as const).map(signal => {
                        const isActive = this.lastFeedbackSignal === signal;
                        return (
                            <button
                                key={signal}
                                title={signal === 'positive' ? 'Good response (👍)' : 'Poor response (👎)'}
                                onClick={() => this.sendFeedback(signal)}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: '2px 4px',
                                    fontSize: '14px',
                                    lineHeight: 1,
                                    opacity: isActive ? 1 : 0.4,
                                    color: isActive
                                        ? (signal === 'positive' ? 'var(--theia-charts-green)' : 'var(--theia-errorForeground)')
                                        : 'inherit',
                                    transition: 'opacity 0.15s',
                                }}
                            >
                                {signal === 'positive' ? '👍' : '👎'}
                            </button>
                        );
                    })}
                </div>
            </div>
        );
    }

    protected async sendFeedback(signal: 'positive' | 'negative'): Promise<void> {
        const agentId = this.currentAgentId;
        if (!agentId) {
            return;
        }
        const sessionId = this.chatService.getActiveSession()?.id;
        this.lastFeedbackSignal = signal;
        this.update(); // re-render to reflect active state
        try {
            await this.configPlane.recordFeedback(agentId, signal, undefined, sessionId);
        } catch {
            // Non-fatal — feedback is best-effort
        }
    }
}
