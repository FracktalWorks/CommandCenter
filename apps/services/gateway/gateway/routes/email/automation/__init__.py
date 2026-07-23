"""automation (subpackage).

Split from a single large layer module into focused submodules; every
submodule name is flattened here so the parent package's public surface is
unchanged.
"""
from __future__ import annotations

from gateway.routes.email.automation import (
    actions,
    analytics,
    assistant,
    chat,
    cleanup,
    drafting,
    engine,
    followups,
    learning,
    replyzero,
    rules,
    runner,
    senders,
    voice_profile,
)  # noqa: F401

# `analytics` imports from `senders`, so it is flattened after it — the loop
# order decides which module wins a name collision.
for _mod in (assistant, drafting, engine, replyzero, chat, followups,
             actions, learning, rules, runner, senders, cleanup, analytics,
             voice_profile):
    for _k, _v in vars(_mod).items():
        if not _k.startswith("__"):
            globals()[_k] = _v
del _mod, _k, _v
