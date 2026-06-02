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
exports.AgentsViewContribution = exports.AGENTS_VIEW_TITLE = exports.OPEN_AGENTS_COMMAND = exports.AGENTS_VIEW_CONTAINER_ID = void 0;
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const agents_panel_1 = require("./agents-panel");
exports.AGENTS_VIEW_CONTAINER_ID = 'commandCenter.agents';
exports.OPEN_AGENTS_COMMAND = {
    id: 'commandCenter.agents.toggle',
    label: 'Command Center: Toggle Agents'
};
exports.AGENTS_VIEW_TITLE = {
    label: 'Agents',
    iconClass: (0, browser_1.codicon)('robot'),
    closeable: true,
};
/**
 * Puts the Agents panel on the activity bar (left side) and opens it by
 * default.  The panel lists all agents, provides an LLM model selector, and
 * lets the user create, switch to, edit, or delete agents.
 */
let AgentsViewContribution = class AgentsViewContribution extends browser_1.AbstractViewContribution {
    constructor() {
        super({
            widgetId: agents_panel_1.AgentsPanelWidget.ID,
            widgetName: agents_panel_1.AgentsPanelWidget.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                rank: 490,
            },
            toggleCommandId: exports.OPEN_AGENTS_COMMAND.id,
        });
    }
    async initializeLayout(_app) {
        await this.openView({ activate: false, reveal: false });
    }
    async onStart(_app) {
        // Ensure the panel is always in the activity bar, even when the layout
        // is restored from a previous session (which skips initializeLayout).
        await this.openView({ activate: false, reveal: false });
    }
    registerCommands(registry) {
        super.registerCommands(registry);
        registry.registerCommand(exports.OPEN_AGENTS_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }
    registerMenus(menus) {
        super.registerMenus(menus);
        menus.registerMenuAction(browser_1.CommonMenus.VIEW_VIEWS, {
            commandId: exports.OPEN_AGENTS_COMMAND.id,
            label: exports.AGENTS_VIEW_TITLE.label,
        });
    }
};
exports.AgentsViewContribution = AgentsViewContribution;
exports.AgentsViewContribution = AgentsViewContribution = __decorate([
    (0, inversify_1.injectable)(),
    __metadata("design:paramtypes", [])
], AgentsViewContribution);
//# sourceMappingURL=agents-view-container.js.map