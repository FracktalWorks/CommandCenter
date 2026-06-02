"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentsModel = void 0;
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const common_2 = require("@theia/core/lib/common");
const config_plane_protocol_1 = require("../common/config-plane-protocol");
/**
 * Shared, singleton model for the Agents panel.  Holds the list of all
 * defined agents and exposes the currently-active agent and LLM selection
 * as reactive state.
 */
let AgentsModel = class AgentsModel {
    constructor() {
        this.onDidChangeEmitter = new common_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.agents = [];
        this.availableSkills = [];
        this.availableTools = [];
        /** Recency-weighted trust score per agent id, populated on refresh. */
        this.trustScores = {};
        this.loading = false;
        // -----------------------------------------------------------------------
        // Mutations
        // -----------------------------------------------------------------------
        this.refresh = async () => {
            this.loading = true;
            this.error = undefined;
            this.onDidChangeEmitter.fire();
            try {
                this.agents = await this.service.listAgents();
                this.availableSkills = await this.service.listSkills().catch(() => []);
                this.availableTools = await this.service.listTools().catch(() => []);
                // Load trust scores in parallel; failures fall back to neutral.
                const scores = await Promise.all(this.agents.map(a => this.service.getAgentTrust(a.id).catch(() => undefined)));
                const next = {};
                this.agents.forEach((a, i) => {
                    const s = scores[i];
                    if (s) {
                        next[a.id] = s;
                    }
                });
                this.trustScores = next;
            }
            catch (e) {
                this.error = e instanceof Error ? e.message : String(e);
            }
            finally {
                this.loading = false;
                this.onDidChangeEmitter.fire();
            }
        };
    }
    init() {
        this.preferences.ready.then(() => {
            this.refresh();
        });
        this.preferences.onPreferenceChanged((e) => {
            if (e.preferenceName === 'ai-features.chat.defaultChatAgent' ||
                e.preferenceName === 'ai-features.openAiCustom.customOpenAiModels' ||
                e.preferenceName === 'ai-features.languageModelAliases') {
                this.onDidChangeEmitter.fire();
            }
        });
    }
    // -----------------------------------------------------------------------
    // Computed properties (read preferences live)
    // -----------------------------------------------------------------------
    get activeAgentId() {
        var _a;
        return (_a = this.preferences.get('ai-features.chat.defaultChatAgent')) !== null && _a !== void 0 ? _a : 'assistant';
    }
    get currentLlm() {
        var _a, _b, _c;
        const aliases = (_a = this.preferences.get('ai-features.languageModelAliases')) !== null && _a !== void 0 ? _a : {};
        return (_c = (_b = aliases['default/universal']) === null || _b === void 0 ? void 0 : _b.selectedModel) !== null && _c !== void 0 ? _c : '';
    }
    get availableLlms() {
        var _a;
        const models = (_a = this.preferences.get('ai-features.openAiCustom.customOpenAiModels')) !== null && _a !== void 0 ? _a : [];
        return models.map(m => m.id);
    }
    async switchToAgent(id) {
        await this.preferences.set('ai-features.chat.defaultChatAgent', id, common_2.PreferenceScope.User);
    }
    async setCurrentLlm(modelId) {
        var _a;
        const current = (_a = this.preferences.get('ai-features.languageModelAliases')) !== null && _a !== void 0 ? _a : {};
        await this.preferences.set('ai-features.languageModelAliases', {
            ...current,
            'default/fast': { selectedModel: modelId },
            'default/universal': { selectedModel: modelId },
            'default/code': { selectedModel: modelId },
            'default/summarize': { selectedModel: modelId },
            'default/code-completion': { selectedModel: modelId },
        }, common_2.PreferenceScope.User);
    }
    async createAgent(draft) {
        const agent = await this.service.createAgent(draft);
        await this.refresh();
        return agent;
    }
    async updateAgent(id, patch) {
        const agent = await this.service.updateAgent(id, patch);
        await this.refresh();
        return agent;
    }
    async deleteAgent(id) {
        await this.service.deleteAgent(id);
        await this.refresh();
    }
    // --- Directive management -------------------------------------------
    async addDirective(agentId, text, source = 'manual') {
        const d = await this.service.addDirective(agentId, text, source);
        await this.refresh();
        return d;
    }
    async updateDirective(agentId, directiveId, text) {
        const d = await this.service.updateDirective(agentId, directiveId, text);
        await this.refresh();
        return d;
    }
    async removeDirective(agentId, directiveId) {
        await this.service.removeDirective(agentId, directiveId);
        await this.refresh();
    }
    async approveDirective(agentId, directiveId) {
        const d = await this.service.approveDirective(agentId, directiveId);
        await this.refresh();
        return d;
    }
    async rejectDirective(agentId, directiveId) {
        const d = await this.service.rejectDirective(agentId, directiveId);
        await this.refresh();
        return d;
    }
    // --- Feedback -------------------------------------------------------
    async recordFeedback(agentId, signal, note, conversationId) {
        await this.service.recordFeedback(agentId, signal, note, conversationId);
    }
    async listFeedback(agentId) {
        return this.service.listFeedback(agentId);
    }
};
exports.AgentsModel = AgentsModel;
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], AgentsModel.prototype, "service", void 0);
__decorate([
    (0, inversify_1.inject)(common_2.PreferenceService),
    __metadata("design:type", Object)
], AgentsModel.prototype, "preferences", void 0);
__decorate([
    (0, inversify_1.postConstruct)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AgentsModel.prototype, "init", null);
exports.AgentsModel = AgentsModel = __decorate([
    (0, inversify_1.injectable)()
], AgentsModel);
//# sourceMappingURL=agents-model.js.map