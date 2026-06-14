-- CommandCenter — MCP Server Registry.
-- Stores Model Context Protocol server configurations.
-- MCP servers self-describe their tools at connection time;
-- the executor queries this table at agent-run time and injects
-- matching servers into GitHubCopilotAgent.mcp_servers.

CREATE TABLE IF NOT EXISTS mcp_servers (
    name         TEXT PRIMARY KEY,              -- e.g. "postgres", "brave-search"
    label        TEXT NOT NULL,                 -- Human-readable name
    description  TEXT NOT NULL DEFAULT '',
    transport    TEXT NOT NULL DEFAULT 'http-sse',  -- 'stdio' | 'http-sse'
    command      TEXT,                          -- stdio: e.g. 'npx -y @modelcontextprotocol/server-postgres'
    url          TEXT,                          -- http-sse: e.g. 'https://mcp.brave.com/sse'
    env_vars     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- env vars for the server process
    headers      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- HTTP headers (auth tokens, etc.)
    agent_scope  JSONB NOT NULL DEFAULT '["*"]'::jsonb, -- ["*"] or ["agent-sales", ...]
    enabled      BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT mcp_servers_transport_check CHECK (
        (transport = 'stdio' AND command IS NOT NULL) OR
        (transport = 'http-sse' AND url IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers (enabled);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_transport ON mcp_servers (transport);

-- Seed a few well-known MCP servers as disabled examples (user enables them).
INSERT INTO mcp_servers (name, label, description, transport, url, enabled)
VALUES
    ('brave-search', 'Brave Search',
     'Live web search via Brave. Agents can research current topics and fetch fresh information.',
     'http-sse', 'https://api.search.brave.com/sse', false),
    ('filesystem', 'Filesystem',
     'Read and write local files. Gives agents persistent workspace storage.',
     'http-sse', null, false),
    ('postgres', 'Postgres',
     'Query PostgreSQL databases directly. Agents can run SQL for reporting and operational queries.',
     'http-sse', null, false),
    ('github', 'GitHub',
     'Full GitHub API access — PRs, issues, code review, commit history.',
     'http-sse', 'https://api.github.com/mcp', false),
    ('slack', 'Slack',
     'Read and post to Slack channels. Agents can coordinate with your team.',
     'http-sse', 'https://slack.com/api/mcp', false)
ON CONFLICT (name) DO NOTHING;
