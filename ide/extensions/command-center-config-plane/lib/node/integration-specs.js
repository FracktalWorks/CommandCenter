"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INTEGRATION_KIND_SPECS = void 0;
/**
 * Declarative schemas for every registrable integration kind. These drive both
 * the human-facing forms in the Integrations side bar and the contract agents
 * follow when creating integrations programmatically (exposed via
 * `getKindSpecs`).
 */
exports.INTEGRATION_KIND_SPECS = [
    {
        kind: 'mcp',
        group: 'mcp',
        title: 'MCP Servers',
        noun: 'MCP Server',
        description: 'Model Context Protocol endpoints. Registered servers expose their tools to every agent and skill.',
        fields: [
            {
                key: 'transport',
                label: 'Transport',
                type: 'select',
                options: ['stdio', 'http'],
                default: 'stdio',
                required: true,
                help: 'stdio launches a local process; http connects to a running server (SSE / streamable HTTP).'
            },
            {
                key: 'command',
                label: 'Command',
                type: 'text',
                placeholder: 'npx',
                help: 'Executable to launch for stdio transport.',
                showWhen: 'transport=stdio'
            },
            {
                key: 'args',
                label: 'Arguments',
                type: 'text',
                placeholder: '-y @modelcontextprotocol/server-github',
                help: 'Space-separated arguments passed to the command.',
                showWhen: 'transport=stdio'
            },
            {
                key: 'url',
                label: 'Server URL',
                type: 'url',
                placeholder: 'https://mcp.example.com/sse',
                help: 'Endpoint URL for http transport.',
                showWhen: 'transport=http'
            },
            {
                key: 'env',
                label: 'Environment',
                type: 'multiline',
                placeholder: 'KEY=value\nANOTHER=value',
                help: 'Extra environment variables for the server process, one KEY=value per line.'
            },
            {
                key: 'token',
                label: 'Auth Token',
                type: 'secret',
                help: 'Optional bearer token / API key the server requires.'
            }
        ]
    },
    {
        kind: 'api',
        group: 'apis',
        title: 'Service APIs',
        noun: 'API',
        description: 'REST / HTTP services agents and skills call. Stored credentials are referenced by name, never inlined.',
        fields: [
            {
                key: 'baseUrl',
                label: 'Base URL',
                type: 'url',
                required: true,
                placeholder: 'https://api.example.com/v1'
            },
            {
                key: 'authType',
                label: 'Auth Type',
                type: 'select',
                options: ['none', 'bearer', 'api-key-header', 'basic', 'oauth2-client-credentials', 'oauth2-authorization-code'],
                default: 'bearer',
                required: true,
                help: 'oauth2-client-credentials = machine-to-machine (auto token). '
                    + 'oauth2-authorization-code = user-delegated consent (browser sign-in + refresh).'
            },
            {
                key: 'headerName',
                label: 'API Key Header',
                type: 'text',
                placeholder: 'X-API-Key',
                help: 'Header the API key is sent in.',
                showWhen: 'authType=api-key-header'
            },
            {
                key: 'apiKey',
                label: 'API Key / Token',
                type: 'secret',
                showWhen: 'authType=bearer'
            },
            {
                key: 'apiKeyHeaderValue',
                label: 'API Key Value',
                type: 'secret',
                showWhen: 'authType=api-key-header'
            },
            {
                key: 'username',
                label: 'Username',
                type: 'text',
                showWhen: 'authType=basic'
            },
            {
                key: 'password',
                label: 'Password',
                type: 'secret',
                showWhen: 'authType=basic'
            },
            // --- OAuth 2.0 (client-credentials + authorization-code) ---------
            {
                key: 'tokenUrl',
                label: 'Token URL',
                type: 'url',
                placeholder: 'https://login.example.com/oauth/token',
                help: 'Provider token endpoint that issues / refreshes access tokens.',
                showWhen: 'authType=oauth2-client-credentials,oauth2-authorization-code'
            },
            {
                key: 'authorizationUrl',
                label: 'Authorization URL',
                type: 'url',
                placeholder: 'https://login.example.com/oauth/authorize',
                help: 'Provider consent endpoint the user opens to grant access.',
                showWhen: 'authType=oauth2-authorization-code'
            },
            {
                key: 'clientId',
                label: 'Client ID',
                type: 'text',
                placeholder: 'your-app-client-id',
                showWhen: 'authType=oauth2-client-credentials,oauth2-authorization-code'
            },
            {
                key: 'clientSecret',
                label: 'Client Secret',
                type: 'secret',
                showWhen: 'authType=oauth2-client-credentials,oauth2-authorization-code'
            },
            {
                key: 'scope',
                label: 'Scopes',
                type: 'text',
                placeholder: 'read write offline_access',
                help: 'Space-separated scopes to request. Include offline_access for refresh tokens where required.',
                showWhen: 'authType=oauth2-client-credentials,oauth2-authorization-code'
            },
            {
                key: 'redirectUri',
                label: 'Redirect URI',
                type: 'text',
                placeholder: 'http://localhost:3000/oauth/callback',
                help: 'Must exactly match a redirect URI registered with the provider. After consent, '
                    + 'copy the "code" query parameter from the redirected URL back into the chat.',
                showWhen: 'authType=oauth2-authorization-code'
            },
            {
                key: 'refreshToken',
                label: 'Refresh Token',
                type: 'secret',
                help: 'Filled automatically after authorization; or paste an existing refresh token to reuse.',
                showWhen: 'authType=oauth2-authorization-code'
            },
            // Auto-managed: written by the OAuth token exchange, hidden from the form.
            {
                key: 'accessToken',
                label: 'Access Token',
                type: 'secret',
                managed: true
            },
            {
                key: 'tokenExpiresAt',
                label: 'Token Expires At',
                type: 'text',
                managed: true
            }
        ]
    },
    {
        kind: 'webhook',
        group: 'webhooks',
        title: 'Webhooks',
        noun: 'Webhook',
        description: 'Inbound triggers and outbound notifications that connect external events to agents and workflows.',
        fields: [
            {
                key: 'direction',
                label: 'Direction',
                type: 'select',
                options: ['incoming', 'outgoing'],
                default: 'incoming',
                required: true,
                help: 'incoming receives external events; outgoing posts to an external URL.'
            },
            {
                key: 'url',
                label: 'Target URL',
                type: 'url',
                placeholder: 'https://hooks.example.com/notify',
                help: 'Where outgoing events are POSTed.',
                showWhen: 'direction=outgoing'
            },
            {
                key: 'path',
                label: 'Inbound Path',
                type: 'text',
                placeholder: '/hooks/my-trigger',
                help: 'Path the gateway listens on for incoming events.',
                showWhen: 'direction=incoming'
            },
            {
                key: 'method',
                label: 'HTTP Method',
                type: 'select',
                options: ['POST', 'GET', 'PUT'],
                default: 'POST'
            },
            {
                key: 'events',
                label: 'Events',
                type: 'text',
                placeholder: 'task.created, deal.won',
                help: 'Comma-separated event names this webhook handles.'
            },
            {
                key: 'signingSecret',
                label: 'Signing Secret',
                type: 'secret',
                help: 'Shared secret used to sign / verify payloads.'
            }
        ]
    },
    {
        kind: 'infra',
        group: 'other',
        title: 'Infrastructure',
        noun: 'Infrastructure Service',
        description: 'Datastores, queues and other backing services agents rely on.',
        fields: [
            {
                key: 'type',
                label: 'Type',
                type: 'select',
                options: ['postgres', 'redis', 's3', 'smtp', 'other'],
                default: 'postgres',
                required: true
            },
            {
                key: 'connectionString',
                label: 'Connection String',
                type: 'text',
                placeholder: 'postgres://host:5432/db',
                help: 'Full DSN. Leave blank to use host / port instead.'
            },
            {
                key: 'host',
                label: 'Host',
                type: 'text',
                placeholder: 'localhost'
            },
            {
                key: 'port',
                label: 'Port',
                type: 'number',
                placeholder: '5432'
            },
            {
                key: 'secret',
                label: 'Password / Access Key',
                type: 'secret'
            }
        ]
    }
];
//# sourceMappingURL=integration-specs.js.map