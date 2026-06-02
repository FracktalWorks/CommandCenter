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
exports.IntegrationsViewContribution = exports.OPEN_INTEGRATIONS_COMMAND = exports.INTEGRATIONS_VIEW_CONTAINER_TITLE = exports.INTEGRATIONS_VIEW_CONTAINER_ID = void 0;
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
exports.INTEGRATIONS_VIEW_CONTAINER_ID = 'commandCenter.integrations';
exports.INTEGRATIONS_VIEW_CONTAINER_TITLE = {
    label: 'Integrations',
    iconClass: (0, browser_1.codicon)('plug'),
    closeable: true
};
exports.OPEN_INTEGRATIONS_COMMAND = {
    id: 'commandCenter.integrations.toggle',
    label: 'Command Center: Toggle Integrations'
};
/**
 * Puts the Integrations side bar on the activity bar (left) and opens it by
 * default. The container hosts one collapsible view per integration group:
 * LLMs, MCP Servers, APIs and Infrastructure & Other.
 */
let IntegrationsViewContribution = class IntegrationsViewContribution extends browser_1.AbstractViewContribution {
    constructor() {
        super({
            widgetId: exports.INTEGRATIONS_VIEW_CONTAINER_ID,
            widgetName: exports.INTEGRATIONS_VIEW_CONTAINER_TITLE.label,
            defaultWidgetOptions: {
                area: 'left',
                rank: 500
            },
            toggleCommandId: exports.OPEN_INTEGRATIONS_COMMAND.id
        });
    }
    /** Open the Integrations side bar by default so it is the active left view on boot. */
    async initializeLayout(_app) {
        await this.openView({ activate: true, reveal: true });
    }
    registerCommands(registry) {
        super.registerCommands(registry);
        registry.registerCommand(exports.OPEN_INTEGRATIONS_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }
    registerMenus(menus) {
        super.registerMenus(menus);
        menus.registerMenuAction(browser_1.CommonMenus.VIEW_VIEWS, {
            commandId: exports.OPEN_INTEGRATIONS_COMMAND.id,
            label: exports.INTEGRATIONS_VIEW_CONTAINER_TITLE.label
        });
    }
};
exports.IntegrationsViewContribution = IntegrationsViewContribution;
exports.IntegrationsViewContribution = IntegrationsViewContribution = __decorate([
    (0, inversify_1.injectable)(),
    __metadata("design:paramtypes", [])
], IntegrationsViewContribution);
//# sourceMappingURL=integrations-view-container.js.map