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
exports.OAuthCallbackContribution = void 0;
const inversify_1 = require("@theia/core/shared/inversify");
const config_plane_service_1 = require("./config-plane-service");
/**
 * Registers the HTTP route that receives the OAuth 2.0 authorization-code
 * redirect from providers (Google, Microsoft, etc.). The redirect URI configured
 * on integrations is `http://localhost:3000/oauth/callback`; without this route
 * the browser shows "Cannot GET /oauth/callback". The handler exchanges the
 * returned `code` for tokens (matched to the originating integration by `state`)
 * and renders a small status page so the user can close the tab.
 */
let OAuthCallbackContribution = class OAuthCallbackContribution {
    configure(app) {
        app.get('/oauth/callback', async (req, res) => {
            var _a;
            const code = typeof req.query.code === 'string' ? req.query.code : '';
            const state = typeof req.query.state === 'string' ? req.query.state : '';
            const providerError = typeof req.query.error === 'string' ? req.query.error : '';
            if (providerError) {
                res.status(400).send(this.renderPage(false, 'Authorization was denied or failed', `The provider returned an error: ${this.escape(providerError)}.`));
                return;
            }
            if (!code || !state) {
                res.status(400).send(this.renderPage(false, 'Invalid OAuth callback', 'The callback is missing the required "code" or "state" parameter.'));
                return;
            }
            try {
                const { result, integrationName } = await this.configPlane.completeOAuthByState(code, state);
                if (result.ok) {
                    const name = integrationName ? this.escape(integrationName) : 'your integration';
                    const detail = result.hasRefreshToken
                        ? 'Access and refresh tokens were stored securely.'
                        : 'An access token was stored securely.';
                    res.status(200).send(this.renderPage(true, 'Connected successfully', `${name} is now authorized. ${detail} You can close this tab and return to the Command Center.`));
                }
                else {
                    res.status(400).send(this.renderPage(false, 'Could not complete authorization', this.escape((_a = result.message) !== null && _a !== void 0 ? _a : 'Token exchange failed.')));
                }
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                res.status(500).send(this.renderPage(false, 'Unexpected error completing OAuth', this.escape(message)));
            }
        });
    }
    renderPage(ok, title, message) {
        const accent = ok ? '#1a7f37' : '#cf222e';
        const icon = ok ? '&#10003;' : '&#10007;';
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${this.escape(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #f6f8fa; color: #1f2328; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 12px; padding: 32px 40px;
          max-width: 460px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; }
  .badge { width: 56px; height: 56px; line-height: 56px; border-radius: 50%;
           background: ${accent}; color: #fff; font-size: 28px; margin: 0 auto 16px; }
  h1 { font-size: 20px; margin: 0 0 8px; color: ${accent}; }
  p { font-size: 14px; line-height: 1.5; margin: 0; color: #57606a; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">${icon}</div>
    <h1>${this.escape(title)}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
    }
    escape(value) {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
};
exports.OAuthCallbackContribution = OAuthCallbackContribution;
__decorate([
    (0, inversify_1.inject)(config_plane_service_1.ConfigPlaneServiceImpl),
    __metadata("design:type", config_plane_service_1.ConfigPlaneServiceImpl)
], OAuthCallbackContribution.prototype, "configPlane", void 0);
exports.OAuthCallbackContribution = OAuthCallbackContribution = __decorate([
    (0, inversify_1.injectable)()
], OAuthCallbackContribution);
//# sourceMappingURL=oauth-callback-contribution.js.map