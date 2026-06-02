// @ts-check
require('reflect-metadata');
const { Container } = require('@theia/core/shared/inversify');

module.exports = Promise.resolve().then(() => {
    const { frontendApplicationModule } = require('@theia/core/lib/browser/frontend-application-module');
    const container = new Container();
    container.load(frontendApplicationModule);
    container.load(require('@theia/editor/lib/browser/editor-frontend-module').default);
    container.load(require('@theia/filesystem/lib/browser/filesystem-frontend-module').default);
    container.load(require('@theia/monaco/lib/browser/monaco-frontend-module').default);
    container.load(require('@theia/preview/lib/browser/preview-frontend-module').default);
    container.load(require('@theia/terminal/lib/browser/terminal-frontend-module').default);
    container.load(require('@theia/debug/lib/browser/debug-frontend-module').default);
    container.load(require('@theia/ai-chat-ui/lib/browser/ai-chat-ui-frontend-module').default);
    container.load(require('@theia/ai-ide/lib/browser/frontend-module').default);
});
