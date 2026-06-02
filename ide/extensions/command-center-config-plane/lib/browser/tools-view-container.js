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
exports.TOOLS_ICON = exports.ToolsViewContribution = exports.OPEN_TOOLS_COMMAND = exports.TOOLS_PANEL_ID = void 0;
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
exports.TOOLS_PANEL_ID = 'commandCenter.tools-panel';
exports.OPEN_TOOLS_COMMAND = {
    id: 'commandCenter.tools.toggle',
    label: 'Command Center: Toggle Tools',
};
/**
 * Puts the Tools panel on the activity bar (left) so users can view, create,
 * edit, and delete user-defined integration tools from the sidebar.
 */
let ToolsViewContribution = class ToolsViewContribution extends browser_1.AbstractViewContribution {
    constructor() {
        super({
            widgetId: exports.TOOLS_PANEL_ID,
            widgetName: 'Tools',
            defaultWidgetOptions: {
                area: 'left',
                rank: 600,
            },
            toggleCommandId: exports.OPEN_TOOLS_COMMAND.id,
        });
    }
    async initializeLayout(_app) {
        // Do not force-open on startup; let the user open it explicitly.
    }
    registerCommands(registry) {
        super.registerCommands(registry);
        registry.registerCommand(exports.OPEN_TOOLS_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true }),
        });
    }
    registerMenus(menus) {
        super.registerMenus(menus);
        menus.registerMenuAction(browser_1.CommonMenus.VIEW_VIEWS, {
            commandId: exports.OPEN_TOOLS_COMMAND.id,
            label: 'Tools',
        });
    }
};
exports.ToolsViewContribution = ToolsViewContribution;
exports.ToolsViewContribution = ToolsViewContribution = __decorate([
    (0, inversify_1.injectable)(),
    __metadata("design:paramtypes", [])
], ToolsViewContribution);
/** Icon class for the Tools activity bar button. */
exports.TOOLS_ICON = (0, browser_1.codicon)('tools');
//# sourceMappingURL=tools-view-container.js.map