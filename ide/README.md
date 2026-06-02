# Command Center — Theia platform shell (`ide/`)

The browser-native shell of the **Command Center** platform: a self-hosted, multi-agent
workspace built on the [Eclipse Theia](https://theia-ide.org) platform (PD-01). Jannet is
one of the AI agents that run inside it; additional agents, skills, and workflows build
*on top of* this shell.

> **Why Theia, not a VS Code fork?** The VS Code Marketplace is legally Microsoft-only;
> every fork (code-server, Cursor, Void) and Theia alike use Open VSX — so a fork gives
> no extension advantage but a heavy rebase tax. Theia is purpose-built to be forked,
> rebranded, and extended. See PD-01 in `../ai-company-brain/project_plan.md`.

## Layout

```
ide/
  package.json          # monorepo root (yarn workspaces + lerna)
  lerna.json
  browser-app/          # the Theia browser application (assembles extensions)
    package.json
  extensions/           # our custom Theia extensions (the fork lives HERE)
    jannet-branding/        # shell branding + "About Jannet.AI"
    jannet-config-plane/    # L1 differentiator: keys / MCP / OAuth / model selection
```

### Extensions-first discipline

We **do not** patch Theia core. All customization lands as Theia *extensions* under
`extensions/*`. Each extension:

- declares `"keywords": ["theia-extension"]` and a `theiaExtensions` entry in its `package.json`,
- exports a default InversifyJS `ContainerModule` from its frontend module,
- depends on `@theia/core` (+ any other `@theia/*` it needs).

This keeps us off the rebase treadmill: upgrading Theia = bumping the pinned
`@theia/*` versions, not re-applying patches.

## Prerequisites

- **Node.js** ≥ 18 (20 LTS recommended)
- **Yarn 1.x** (`>=1.7.0 <2`) — Theia's build uses Yarn 1 workspaces, *not* Yarn 2+/Berry
- Native build toolchain for `node-gyp` (Theia rebuilds native deps for the browser target)

## Build & run

```bash
cd ide

# 1. install all workspaces + build the custom extensions (lerna `prepare`)
yarn

# 2. bundle the browser app
yarn build:browser

# 3. start it — open http://localhost:3000
yarn start:browser
```

During development:

```bash
# rebuild extensions on change…
yarn watch:browser
# …and (in a second terminal) rebuild the app bundle on change
yarn --cwd browser-app watch
```

## What's included

`browser-app` assembles the core Theia extensions (editor, filesystem, monaco,
navigator, terminal, preferences, search, vsx-registry, …), the **Theia AI**
packages (`@theia/ai-core`, `ai-chat`, `ai-chat-ui`, `ai-mcp`, `ai-openai`,
`ai-anthropic`, …), and our two custom extensions.

| Extension | Purpose | Status |
| --- | --- | --- |
| `jannet-branding` | Renames the shell to *Jannet.AI*, adds Help → About | scaffold |
| `jannet-config-plane` | View for API keys, MCP servers, OAuth tokens, model selection | scaffold (UI placeholder; backend `ConfigService` lands in L1-04/L1-09) |

## Roadmap (L1)

See `../ai-company-brain/product_requirements.md` (L1-01 … L1-12) and
`../ai-company-brain/project_plan.md` (milestone **M1**). Next implementation steps:

1. Back the Config Plane with a secrets-aware backend service (encrypted at rest).
2. Wire model selection to `acb_llm` → LiteLLM.
3. Register MCP servers from the Config Plane into `@theia/ai-mcp`.
