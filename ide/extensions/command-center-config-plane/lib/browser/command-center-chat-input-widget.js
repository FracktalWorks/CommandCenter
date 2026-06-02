"use strict";
// *****************************************************************************
// Command Center custom chat input widget.
//
// Extends Theia's AIChatInputWidget to surface a model picker and an agent
// picker directly inside the chat input box (Copilot / Claude-Code style),
// rather than in the separate Agents side panel. The agent picker switches the
// receiving agent on the fly within the current chat session by setting the
// session's pinned agent.
// *****************************************************************************
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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandCenterChatInputWidget = void 0;
const React = __importStar(require("@theia/core/shared/react"));
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const chat_input_widget_1 = require("@theia/ai-chat-ui/lib/browser/chat-input-widget");
const ai_chat_1 = require("@theia/ai-chat");
const config_plane_protocol_1 = require("../common/config-plane-protocol");
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
function modelLabel(id) {
    return id
        .replace('gemini-', 'Gemini ')
        .replace('-flash-preview', ' Flash Preview')
        .replace('-flash', ' Flash')
        .replace('-pro-preview', ' Pro Preview')
        .replace('-pro', ' Pro');
}
let CommandCenterChatInputWidget = class CommandCenterChatInputWidget extends chat_input_widget_1.AIChatInputWidget {
    constructor() {
        super(...arguments);
        /** Agent ids hidden from the picker (definitions with showInChat=false, e.g. Reflector). */
        this.hiddenAgentIds = new Set();
        this.ccListenersBound = false;
    }
    init() {
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
    async refreshHiddenAgents() {
        try {
            const agents = await this.configPlane.listAgents();
            this.hiddenAgentIds = new Set(agents.filter(a => a.showInChat === false).map(a => a.id));
            this.update();
        }
        catch {
            /* leave previous set in place on error */
        }
    }
    /** Re-render the selector bar when models, agents or the session change. */
    bindCcListeners() {
        if (this.ccListenersBound) {
            return;
        }
        this.ccListenersBound = true;
        const prefs = this.preferenceService;
        if (prefs) {
            this.toDispose.push(prefs.onPreferenceChanged(e => {
                if (e.preferenceName === ALIASES_PREF ||
                    e.preferenceName === OPENAI_MODELS_PREF ||
                    e.preferenceName === GOOGLE_MODELS_PREF ||
                    e.preferenceName === DEFAULT_AGENT_PREF) {
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
    get availableModels() {
        var _a, _b, _c, _d;
        // Native Google provider: bare ids like 'gemini-2.5-flash' stored in
        // GOOGLE_MODELS_PREF; registered with a 'google/' prefix.
        const googleBareIds = (_b = (_a = this.preferenceService) === null || _a === void 0 ? void 0 : _a.get(GOOGLE_MODELS_PREF)) !== null && _b !== void 0 ? _b : [];
        const googleIds = googleBareIds.map(id => `google/${id}`);
        // Custom OpenAI-compat models (may be empty when only Google is used).
        const openaiModels = (_d = (_c = this.preferenceService) === null || _c === void 0 ? void 0 : _c.get(OPENAI_MODELS_PREF)) !== null && _d !== void 0 ? _d : [];
        const openaiIds = openaiModels.map(m => m.id).filter(Boolean);
        // Deduplicate; Google models first.
        return [...new Set([...googleIds, ...openaiIds])];
    }
    get currentModel() {
        var _a, _b, _c, _d;
        const aliases = (_b = (_a = this.preferenceService) === null || _a === void 0 ? void 0 : _a.get(ALIASES_PREF)) !== null && _b !== void 0 ? _b : {};
        return (_d = (_c = aliases['default/universal']) === null || _c === void 0 ? void 0 : _c.selectedModel) !== null && _d !== void 0 ? _d : '';
    }
    async setModel(modelId) {
        var _a, _b, _c;
        const current = (_b = (_a = this.preferenceService) === null || _a === void 0 ? void 0 : _a.get(ALIASES_PREF)) !== null && _b !== void 0 ? _b : {};
        const next = { ...current };
        for (const alias of SYNCED_ALIASES) {
            next[alias] = { selectedModel: modelId };
        }
        await ((_c = this.preferenceService) === null || _c === void 0 ? void 0 : _c.set(ALIASES_PREF, next, common_1.PreferenceScope.User));
    }
    // --- Agent selection -------------------------------------------------
    get chatAgents() {
        return this.chatAgentService.getAgents().filter(a => !this.hiddenAgentIds.has(a.id) &&
            (!a.locations || a.locations.length === 0 || a.locations.includes(ai_chat_1.ChatAgentLocation.Panel)));
    }
    get currentAgentId() {
        var _a, _b, _c;
        const active = this.chatService.getActiveSession();
        if (active === null || active === void 0 ? void 0 : active.pinnedAgent) {
            return active.pinnedAgent.id;
        }
        return (_b = (_a = this.receivingAgent) === null || _a === void 0 ? void 0 : _a.agentId) !== null && _b !== void 0 ? _b : (_c = this.preferenceService) === null || _c === void 0 ? void 0 : _c.get(DEFAULT_AGENT_PREF);
    }
    /** Switch the receiving agent for the current session on the fly. */
    async setAgent(agentId) {
        var _a;
        const agent = this.chatAgentService.getAgent(agentId);
        if (!agent) {
            return;
        }
        const active = this.chatService.getActiveSession();
        if (active) {
            active.pinnedAgent = agent;
        }
        this.pinnedAgent = agent;
        await ((_a = this.preferenceService) === null || _a === void 0 ? void 0 : _a.set(DEFAULT_AGENT_PREF, agentId, common_1.PreferenceScope.User));
        this.scheduleUpdateReceivingAgent();
        this.update();
    }
    // --- Rendering -------------------------------------------------------
    render() {
        return (React.createElement("div", { className: 'command-center-chat-input-wrapper', style: { display: 'flex', flexDirection: 'column', alignSelf: 'stretch', width: '100%', overflow: 'hidden' } },
            super.render(),
            this.renderSelectorBar()));
    }
    renderSelectorBar() {
        var _a, _b;
        const models = this.availableModels;
        const agents = this.chatAgents;
        const currentModel = this.currentModel;
        const currentAgentId = this.currentAgentId;
        const currentAgentName = (_b = (_a = agents.find(a => a.id === currentAgentId)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Select agent…';
        const currentModelLabel = currentModel ? modelLabel(currentModel) : 'Select model…';
        // Shared font / spacing for all picker items
        const ITEM_FONT = {
            fontSize: '0.78em',
            whiteSpace: 'nowrap',
        };
        const renderSelect = (label, iconClass, displayText, value, options, onChange) => (React.createElement("label", { style: { display: 'flex', alignItems: 'center', gap: '4px', opacity: 0.85 }, title: label },
            React.createElement("span", { className: `codicon ${iconClass}`, style: { fontSize: '14px', lineHeight: '14px', width: '14px', height: '14px', flex: '0 0 auto', opacity: 0.7 } }),
            React.createElement("div", { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
                React.createElement("span", { style: {
                        ...ITEM_FONT,
                        padding: '1px 18px 1px 6px',
                        background: 'var(--theia-input-background)',
                        color: 'var(--theia-input-foreground)',
                        border: '1px solid var(--theia-input-border, var(--theia-editorWidget-border))',
                        borderRadius: '4px',
                        pointerEvents: 'none',
                        userSelect: 'none',
                    } }, displayText),
                React.createElement("span", { style: {
                        position: 'absolute',
                        right: '4px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        pointerEvents: 'none',
                        fontSize: '9px',
                        opacity: 0.6,
                        lineHeight: 1,
                        color: 'var(--theia-input-foreground)',
                    } }, "\u25BE"),
                React.createElement("select", { style: {
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        opacity: 0,
                        cursor: 'pointer',
                    }, value: value, onChange: e => onChange(e.target.value) }, options.map(o => React.createElement("option", { key: o.value, value: o.value }, o.label))))));
        return (React.createElement("div", { className: 'command-center-chat-selector-bar', style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '3px 8px 4px',
                flexWrap: 'wrap',
            } },
            agents.length > 0 && renderSelect('Agent that will answer in this chat', 'codicon-hubot', currentAgentName, currentAgentId !== null && currentAgentId !== void 0 ? currentAgentId : '', [
                ...(!currentAgentId ? [{ value: '', label: 'Select agent…' }] : []),
                ...agents.map(a => ({ value: a.id, label: a.name })),
            ], v => this.setAgent(v)),
            models.length > 0 && renderSelect('Model used for this chat', 'codicon-symbol-enum', currentModelLabel, currentModel !== null && currentModel !== void 0 ? currentModel : '', [
                ...(!currentModel ? [{ value: '', label: 'Select model…' }] : []),
                ...models.map(id => ({ value: id, label: modelLabel(id) })),
            ], v => this.setModel(v)),
            React.createElement("div", { style: { display: 'flex', gap: '2px', marginLeft: 'auto' } }, ['positive', 'negative'].map(signal => {
                const isActive = this.lastFeedbackSignal === signal;
                return (React.createElement("button", { key: signal, title: signal === 'positive' ? 'Good response (👍)' : 'Poor response (👎)', onClick: () => this.sendFeedback(signal), style: {
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
                    } }, signal === 'positive' ? '👍' : '👎'));
            }))));
    }
    async sendFeedback(signal) {
        var _a;
        const agentId = this.currentAgentId;
        if (!agentId) {
            return;
        }
        const sessionId = (_a = this.chatService.getActiveSession()) === null || _a === void 0 ? void 0 : _a.id;
        this.lastFeedbackSignal = signal;
        this.update(); // re-render to reflect active state
        try {
            await this.configPlane.recordFeedback(agentId, signal, undefined, sessionId);
        }
        catch {
            // Non-fatal — feedback is best-effort
        }
    }
};
exports.CommandCenterChatInputWidget = CommandCenterChatInputWidget;
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], CommandCenterChatInputWidget.prototype, "configPlane", void 0);
exports.CommandCenterChatInputWidget = CommandCenterChatInputWidget = __decorate([
    (0, inversify_1.injectable)()
], CommandCenterChatInputWidget);
//# sourceMappingURL=command-center-chat-input-widget.js.map