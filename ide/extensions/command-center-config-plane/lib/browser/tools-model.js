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
exports.ToolsModel = void 0;
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const config_plane_protocol_1 = require("../common/config-plane-protocol");
/**
 * Shared, singleton model behind the Tools side bar.  Holds the live tool
 * registry and the integration list (so the panel can show names), and
 * notifies the panel widget on change.
 */
let ToolsModel = class ToolsModel {
    constructor() {
        this.onDidChangeEmitter = new common_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.tools = [];
        this.integrations = [];
        this.loading = false;
        this.refresh = async () => {
            this.loading = true;
            this.error = undefined;
            this.onDidChangeEmitter.fire();
            try {
                const [tools, integrations] = await Promise.all([
                    this.service.listTools(),
                    this.service.listIntegrations(),
                ]);
                this.tools = tools;
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
    integrationName(id) {
        var _a, _b;
        return (_b = (_a = this.integrations.find(i => i.id === id)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : id;
    }
    async create(draft) {
        await this.service.createTool(draft);
        await this.refresh();
    }
    async update(id, patch) {
        await this.service.updateTool(id, patch);
        await this.refresh();
    }
    async remove(id) {
        await this.service.deleteTool(id);
        await this.refresh();
    }
};
exports.ToolsModel = ToolsModel;
__decorate([
    (0, inversify_1.inject)(config_plane_protocol_1.ConfigPlaneService),
    __metadata("design:type", Object)
], ToolsModel.prototype, "service", void 0);
__decorate([
    (0, inversify_1.postConstruct)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], ToolsModel.prototype, "init", null);
exports.ToolsModel = ToolsModel = __decorate([
    (0, inversify_1.injectable)()
], ToolsModel);
//# sourceMappingURL=tools-model.js.map