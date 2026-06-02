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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JannetBrandingMenuContribution = exports.JannetBrandingCommandContribution = exports.JannetAboutCommand = void 0;
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const browser_1 = require("@theia/core/lib/browser");
exports.JannetAboutCommand = {
    id: 'commandCenter.about',
    label: 'Command Center: About'
};
let JannetBrandingCommandContribution = class JannetBrandingCommandContribution {
    constructor(messageService) {
        this.messageService = messageService;
    }
    registerCommands(registry) {
        registry.registerCommand(exports.JannetAboutCommand, {
            execute: () => this.messageService.info('Command Center — a self-hosted, browser-based multi-agent platform built on Eclipse Theia. Jannet and other agents, skills, and workflows build on top.')
        });
    }
};
exports.JannetBrandingCommandContribution = JannetBrandingCommandContribution;
exports.JannetBrandingCommandContribution = JannetBrandingCommandContribution = __decorate([
    (0, inversify_1.injectable)(),
    __param(0, (0, inversify_1.inject)(common_1.MessageService)),
    __metadata("design:paramtypes", [common_1.MessageService])
], JannetBrandingCommandContribution);
let JannetBrandingMenuContribution = class JannetBrandingMenuContribution {
    registerMenus(menus) {
        menus.registerMenuAction(browser_1.CommonMenus.HELP, {
            commandId: exports.JannetAboutCommand.id,
            label: 'About Command Center'
        });
    }
};
exports.JannetBrandingMenuContribution = JannetBrandingMenuContribution;
exports.JannetBrandingMenuContribution = JannetBrandingMenuContribution = __decorate([
    (0, inversify_1.injectable)()
], JannetBrandingMenuContribution);
//# sourceMappingURL=command-center-branding-contribution.js.map