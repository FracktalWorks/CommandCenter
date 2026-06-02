/// <reference types="express" />
import { BackendApplicationContribution } from '@theia/core/lib/node';
import * as express from '@theia/core/shared/express';
import { ConfigPlaneServiceImpl } from './config-plane-service';
/**
 * Registers the HTTP route that receives the OAuth 2.0 authorization-code
 * redirect from providers (Google, Microsoft, etc.). The redirect URI configured
 * on integrations is `http://localhost:3000/oauth/callback`; without this route
 * the browser shows "Cannot GET /oauth/callback". The handler exchanges the
 * returned `code` for tokens (matched to the originating integration by `state`)
 * and renders a small status page so the user can close the tab.
 */
export declare class OAuthCallbackContribution implements BackendApplicationContribution {
    protected readonly configPlane: ConfigPlaneServiceImpl;
    configure(app: express.Application): void;
    protected renderPage(ok: boolean, title: string, message: string): string;
    protected escape(value: string): string;
}
