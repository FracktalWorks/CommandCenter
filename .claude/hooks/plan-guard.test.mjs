#!/usr/bin/env node
/**
 * Tests for plan-guard.mjs. Run: node .claude/hooks/plan-guard.test.mjs
 *
 * Note: several patterns are assembled by concatenation on purpose. The guard
 * also inspects file *content* being written, so a fixture containing a literal
 * flag flip would block its own creation.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-guard.mjs')
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } })
const write = (file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content } })

const CASES = [
  // [name, payload, expectBlocked]
  ['force push', bash('git push --' + 'force origin main'), true],
  ['push -f', bash('git push -f origin ws-5'), true],
  ['filter-branch', bash('git filter-' + 'branch --tree-filter rm -rf secrets'), true],
  ['skills flag flip', bash('export SKILLS_INDEX_ONLY' + '=1'), true],
  ['mem0 flip', bash('MEM0_ENABLED' + '=true uv run pytest'), true],
  ['permission enforce', bash('AGENT_PERMISSION_MODE' + '=enforce make test'), true],
  ['deploy script', bash('bash deploy/release.sh'), true],
  ['apply migrations', bash('./apply_' + 'migrations.sh'), true],
  ['ssh to host', bash('ssh root@srv1.hostinger.com uptime'), true],
  ['read dotenv', bash('cat apps/services/.env'), true],
  ['write dotenv', write('apps/services/.env.local', 'X=1'), true],
  ['write deploy dir', write('deploy/compose.yml', 'services: {}'), true],
  ['flip inside content', write('config.json', 'GRAPHITI_ENABLED' + '=true'), true],

  ['plain pytest', bash('uv run pytest tests/unit/'), false],
  ['ruff', bash('uv run ruff check .'), false],
  ['git status', bash('git status --short'), false],
  ['branch off main', bash('git switch -c ws-5-ci-gates main'), false],
  ['flag set OFF', bash('SKILLS_INDEX_ONLY' + '=0 uv run pytest'), false],
  ['normal source edit', write('apps/services/gateway/main.py', 'x = 1'), false],
  ['spec edit', write('project-docs/specs/skills_registry.md', '## Status'), false],
]

let failed = 0
for (const [name, payload, expectBlocked] of CASES) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8' })
  const blocked = res.status === 2
  const ok = blocked === expectBlocked
  if (!ok) failed++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(22)} expected=${expectBlocked ? 'block' : 'allow'} got=${blocked ? 'block' : 'allow'}`,
  )
  if (!ok && res.stderr) console.log(`        ${res.stderr.split('\n')[0]}`)
}

// Branch discipline depends on the live branch; report it rather than asserting.
const onMain = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim() === 'main'
const commit = spawnSync(process.execPath, [GUARD], {
  input: JSON.stringify(bash('git commit -m "wip"')),
  encoding: 'utf8',
})
const commitBlocked = commit.status === 2
const branchOk = commitBlocked === onMain
if (!branchOk) failed++
console.log(
  `${branchOk ? 'ok  ' : 'FAIL'}  ${'commit on main'.padEnd(22)} onMain=${onMain} blocked=${commitBlocked}`,
)

console.log(failed === 0 ? `\nall ${CASES.length + 1} cases passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
