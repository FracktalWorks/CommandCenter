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
exports.IntegrationsModel = void 0;
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const config_plane_protocol_1 = require("../common/config-plane-protocol");
/**
 * Shared, singleton model behind the Integrations side bar. Holds the env
 * snapshot, the registrable kind schemas and the live registry of integrations,
 * and notifies every section view on change so a single refresh updates all.
 */
let IntegrationsModel = class IntegrationsModel {
    constructor() {
        this.onDidChangeEmitter = new common_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.kindSpecs = [];
        this.integrations = [];
        this.loading = false;
        this.refresh = async () => {
            this.loading = true;
            this.error = undefined;
            this.onDidChangeEmitter.fire();
            try {
                const [snapshot, kindSpecs, integrations] = await Promise.all([
                    this.service.getSnapshot(),
                    this.service.getKindSpecs(),
                    this.service.listIntegrations()
                ]);
                this.snapshot = snapshot;
                this.kindSpecs = kindSpecs;
                this.integrations = integrations;
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
        this.refresh();
    }
    /** Env config sections belonging to a given side-bar view. */
    sectionsFor(group) {
        var _a, _b;
        return (_b = (_a = this.snapshot) === null || _a === void 0 ? void 0 : _a.sections.filter(s => s.group === group)) !== null && _b !== void 0 ? _b : [];
    }
    /** The registrable kind managed under a given side-bar view, if any. */
    kindFor(group) {
        return this.kindSpecs.find(s => s.group === group);
    }
    /** Registered integrations of a given kind. */
    integrationsOfKind(kind) {
        return this.integrations.filter(i => i.kind === kind);
    }
    async create(draft) {
        await this.service.createIntegration(draft);
        await this.refresh();
    }
    async update(id, patch) {
        await this.service.updateIntegration(id, patch);
        await this.refresh();
    }
    async setEnabled(id, enabled) {
        await this.service.setIntegrationEnabled(id, enabled);
        await this.refresh();
    }
    async remove(id) {
        await this.service.deleteIntegration(id);
        await this.refresh();
    }
};
exports.IntegrationsModel = IntegrationsModel;
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], IntegrationsModel.prototype, "service", void 0);
__decorate([
    (0, inversify_1.postConstruct)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], IntegrationsModel.prototype, "init", null);
exports.IntegrationsModel = IntegrationsModel = __decorate([
    (0, inversify_1.injectable)()
], IntegrationsModel);
//# sourceMappingURL=integrations-model.js.map