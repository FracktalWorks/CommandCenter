# acb_skills -- Agent Loading and Skill Management

## Purpose

acb_skills provides the Dynamic Agent Loader -- the subsystem that clones agent
repos from GitHub, syncs local folders, initialises local git tracking, injects
integration credentials, imports agents.py at runtime, and manages the persistent
clone cache.

## Ownership

- Owner: CommandCenter Core team
- Path: packages/acb_skills/

## Local Contracts

1. loader.py -- load_agent() is the main entry point. Supports GitHub repo_url and local_path.
2. integrations.py -- build_integrations() resolves credentials from the Integration Registry.
3. agent_tools.py -- call_agent, call_agents_parallel, call_agent_background for cross-agent delegation.
4. web_tools.py -- web_search (DuckDuckGo) and fetch_page (Jina Reader). Zero credential.
5. write_artifact.py -- write_artifact tool for surfacing created files in the UI.

## Work Guidance

### Loading agents
- GitHub agents: git clone (first time) -> git pull --ff-only (subsequent)
- Local agents: _ensure_local_git_repo() syncs source to cache, git init if needed
- Cache at {agents_clone_dir}/repos/{agent_name}/
- agent_dir always points to the cache directory (isolated from source)
- Bot git identity configured automatically (commandcenter-bot)

### Adding a new injected tool
1. Define the async function in the appropriate module
2. Add to _extra_tools list in executor.py:_inject_agent_tools()
3. Add tool guidance to _build_injected_tools_addendum()
4. Tool must be async and accept simple types (str, dict) for Copilot SDK compatibility
5. Wrap with normalize_tools() for GitHubCopilotAgent compatibility

### Local git tracking
- _ensure_local_git_repo() handles source->cache sync and git init
- _sync_source_to_cache() copies only changed files (timestamp+size check)
- Files in cache not in source are preserved (agent-generated improvements)
- Initial commit serves as rollback baseline

## Verification

- pytest tests/unit/test_acb_skills.py
- Agent loading must work with both GitHub and local_path agents
- Mutation sandbox must be able to mount cache directories

## Child DOX Index

None -- leaf package.
