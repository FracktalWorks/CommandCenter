"""transport (subpackage).

Split from a single large layer module into focused submodules; every
submodule name is flattened here so the parent package's public surface is
unchanged.
"""
from __future__ import annotations

from gateway.routes.email.transport import (
    accounts,
    attachments,
    folders,
    messages,
    oauth,
    search,
    send,
    sync,
)  # noqa: F401

for _mod in (accounts, attachments, folders, messages, oauth, search, send,
             sync):
    for _k, _v in vars(_mod).items():
        if not _k.startswith("__"):
            globals()[_k] = _v
del _mod, _k, _v
