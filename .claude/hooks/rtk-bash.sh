#!/usr/bin/env bash
# RTK (Rust Token Killer) PreToolUse hook for Claude Code Bash calls.
#
# Purpose: shrink noisy shell OUTPUT (pytest/ruff/git/docker/...) before it
# lands in the agent's context window. Claimed 60-90% reduction on covered
# commands, with full output tee'd to disk on failure so nothing is lost.
#
# WHY A WRAPPER INSTEAD OF `rtk init`'s DEFAULT HOOK:
# The stock rtk hook rewrites EVERYTHING, including two cases that are wrong
# for this repo:
#   1. `uv run pytest ...`  ->  `uv run rtk pytest ...`  (BROKEN: rtk is a
#      Windows binary, not a uv-managed tool; running it inside uv's venv fails)
#   2. `cat FILE` / `head` / `tail`  ->  `rtk read FILE`  (UNWANTED: codegraph
#      and the built-in Read tool give better, symbol-aware file context than
#      rtk's heuristic filtering)
# So this wrapper is a strict allowlist: it rewrites ONLY the safe command
# classes and passes everything else through untouched.
#
# Contract: Claude Code sends the PreToolUse event as JSON on stdin. To rewrite
# the command we emit JSON on stdout with hookSpecificOutput.updatedInput; to
# leave it untouched we emit nothing and exit 0.
#
# Disable at any time by removing the hook block from .claude/settings.json,
# or set RTK_DISABLE=1 in the environment.

set -euo pipefail

# Escape hatch: honor a global off-switch.
if [ "${RTK_DISABLE:-0}" = "1" ]; then
  exit 0
fi

# rtk must be reachable. If it isn't (fresh clone without rtk installed), do
# nothing rather than break the user's Bash tool.
if ! command -v rtk >/dev/null 2>&1; then
  exit 0
fi

payload="$(cat)"

# Extract tool name and command. jq if present, else python (Git Bash on
# Windows usually lacks jq). The python reader emits both fields on two lines
# so we parse the JSON exactly once.
if command -v jq >/dev/null 2>&1; then
  tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)"
  command="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
else
  fields="$(printf '%s' "$payload" | python -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(d.get("tool_name", ""))
print(d.get("tool_input", {}).get("command", ""))
' 2>/dev/null)"
  tool_name="$(printf '%s\n' "$fields" | sed -n '1p')"
  command="$(printf '%s\n' "$fields" | sed -n '2p')"
fi

# Only act on Bash tool calls with a non-empty command.
if [ "$tool_name" != "Bash" ] || [ -z "$command" ]; then
  exit 0
fi

# --- Strict allowlist / denylist ------------------------------------------
# Skip anything we know rtk mishandles or that we deliberately keep native.
# Match on the FIRST token (leading word) of the command.
first_word="$(printf '%s' "$command" | sed -E 's/^[[:space:]]+//' | awk '{print $1}')"

case "$command" in
  # uv is our package/test runner; rtk inserts itself in the wrong position.
  uv\ *|*\ uv\ *) exit 0 ;;
esac

case "$first_word" in
  # File reads: keep native (codegraph / Read tool are better than rtk read).
  cat|less|more|head|tail|bat) exit 0 ;;
  # The safe, high-value command classes rtk actually improves.
  git|pytest|ruff|mypy|docker|psql|pip|npm|pnpm|npx|tsc|eslint|prettier|go|cargo|jest|vitest|playwright|kubectl|find|grep|rg|ls|tree|diff|wc|curl|gh) ;;
  # Everything else: passthrough untouched.
  *) exit 0 ;;
esac

# Ask rtk's own hook engine how it would rewrite this exact command.
rewritten="$(rtk hook check "$command" 2>/dev/null || true)"

# rtk emits "No rewrite for: ..." (or empty) when it has no filter. In that
# case, or if the rewrite is unchanged, do nothing.
case "$rewritten" in
  ''|No\ rewrite\ for:*) exit 0 ;;
esac
if [ "$rewritten" = "$command" ]; then
  exit 0
fi

# Defense in depth: never allow a rewrite that reintroduces the broken forms.
case "$rewritten" in
  *uv\ run\ rtk\ *) exit 0 ;;
  rtk\ read\ *) exit 0 ;;
esac

# Emit the rewrite in Claude Code's PreToolUse shape. The rewrite is only
# honored when permissionDecision is present alongside updatedInput; without
# it, exit-0-with-JSON falls back to allowing the ORIGINAL command unchanged.
# NOTE: this auto-approves the REWRITTEN command, so the strict allowlist above
# is the security boundary — only benign read/test/lint/git commands reach here.
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg cmd "$rewritten" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"rtk output compression",updatedInput:{command:$cmd}}}'
else
  python - "$rewritten" <<'PY'
import json, sys
cmd = sys.argv[1]
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "permissionDecisionReason": "rtk output compression",
      "updatedInput": {"command": cmd}}}))
PY
fi
exit 0
