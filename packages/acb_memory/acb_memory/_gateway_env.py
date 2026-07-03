"""Shared guard: force a third-party OpenAI client through our gateway.

Both mem0 and graphiti-core build their own ``openai.OpenAI`` client and,
BEFORE honouring the ``base_url``/``openai_base_url`` we pass, short-circuit to
another provider when certain env vars are present.  mem0 2.0.4's
``OpenAILLM.__init__`` is the canonical example::

    if os.environ.get("OPENROUTER_API_KEY"):   # → base_url=openrouter.ai
        self.client = OpenAI(api_key=OPENROUTER_API_KEY, base_url=...)
    else:                                       # ← the branch we WANT
        base_url = self.config.openai_base_url or os.getenv("OPENAI_BASE_URL") or ...

Because ``OPENROUTER_API_KEY`` is legitimately set platform-wide (acb_llm's key
store uses it), the client diverts to OpenRouter and sends our gateway tier
alias (``tier-fast``) as a literal model → ``400 tier-fast is not a valid model
id``.  Memory write-back then fails silently for every agent.

Fix: build the client with these override vars removed, so it takes the branch
that honours the ``openai_base_url`` we pass (our gateway /v1, which resolves
tier aliases via LiteLLM).  The vars are restored immediately after; they stay
set for the rest of the process.  mem0/graphiti create their LLM client eagerly
at construction and reuse it, so guarding construction is sufficient.
"""
from __future__ import annotations

import contextlib
import os
from collections.abc import Iterator

# Provider-override env vars that hijack a third-party OpenAI client away from
# the base_url we pass.  Keep OPENROUTER first — it's the active culprit.
HIJACK_ENV_VARS = ("OPENROUTER_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE")


@contextlib.contextmanager
def gateway_only_env() -> Iterator[None]:
    """Temporarily drop provider-override env vars for the duration of the block.

    Use around the construction of a mem0/graphiti client so it routes LLM +
    embedding calls through our gateway instead of OpenRouter/etc.  Restores the
    environment on exit (including on exception).
    """
    saved = {k: os.environ.pop(k, None) for k in HIJACK_ENV_VARS}
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v
