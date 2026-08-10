"""Seam double for the converted ``gateway.routes.email`` handlers (H2).

Converted request handlers acquire their session via the package's
``_tenant_session`` alias — ``acb_common.db.tenant_session``, an async context
manager that begins a transaction, binds the tenant GUC and commits on clean
exit. ``bind_db`` mirrors only that SHAPE over any test double: it yields the
fake, then ``await``s its ``commit`` (if it has one) on a clean exit — exactly
like the real wrapper, which commits reads too — and commits nothing when the
body raised. Patch it over the SUT module's ``_tenant_session`` BY NAME
(each submodule imports the alias from ``core``, so patch the module you call).

Not named ``test_*``, so pytest imports it without collecting it. The GUC
plumbing itself is pinned by ``test_tenant_session.py``, not mirrored here.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any


def bind_db(db: Any):
    """A ``_tenant_session`` double bound to ``db``.

    The returned factory records each entry in ``.calls`` so a test can assert
    "no session was opened" (the old ``get_db.assert_not_awaited()`` proxy).
    """
    calls: list[int] = []

    @asynccontextmanager
    async def _tenant_session():
        calls.append(1)
        yield db
        commit = getattr(db, "commit", None)
        if commit is not None:
            await commit()

    _tenant_session.calls = calls  # type: ignore[attr-defined]
    _tenant_session.db = db  # type: ignore[attr-defined]
    return _tenant_session
