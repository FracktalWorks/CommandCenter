"""Automation · sender identity & direction.

The single primitive both the rule classifier and the sender categorizer use to
decide whether a message's sender is the mailbox owner (``self``), the owner's
ORGANISATION (``internal`` — same email domain, or a configured extra domain), or
``external``.

Why it exists: classification looks at one email in isolation, so an OUTBOUND
business document — e.g. an invoice your sales team sent a customer — reads like a
RECEIVED ``Receipt``. Knowing the sender is you / your org lets the classifier
refuse the receive-only categories (Receipt / Newsletter / Marketing / Cold
Email) for your own outbound/internal mail and treat it as FYI instead.

``extra_domains`` carries the OPTIONAL ``org_domains`` setting (extra domains
beyond the account's own); when none are configured, detection is same-domain
only and needs no setup.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import text


def _domain_of(addr: str) -> str:
    addr = (addr or "").strip().lower()
    return addr.rsplit("@", 1)[1] if "@" in addr else ""


def normalize_domain(raw: str) -> str:
    """A user-entered domain → bare lowercase host: strips a leading ``@``, an
    ``email@`` local-part, a trailing path, and surrounding whitespace. '' if
    empty."""
    d = (raw or "").strip().lower().lstrip("@")
    if "@" in d:  # someone pasted a full address
        d = d.rsplit("@", 1)[1]
    return d.split("/")[0].strip()  # drop any trailing path


async def resolve_org_domains(db: Any, account_id: str) -> frozenset[str]:
    """The account's configured EXTRA org domains (``email_assistant_settings.
    org_domains``), normalized. The account's own domain is always internal via
    ``sender_scope`` regardless, so this is purely additive. Returns an empty set
    on any error / no config / pre-migration (column absent), so callers degrade
    to same-domain detection."""
    try:
        row = (await db.execute(text(
            "SELECT org_domains FROM email_assistant_settings "
            "WHERE account_id = :aid"
        ), {"aid": account_id})).fetchone()
    except Exception:  # noqa: BLE001 — column may not exist yet / DB hiccup
        return frozenset()
    vals = getattr(row, "org_domains", None) if row else None
    if not vals:
        return frozenset()
    try:
        return frozenset(
            nd for v in vals
            if isinstance(v, str) and (nd := normalize_domain(v)))
    except TypeError:  # vals not iterable (e.g. a mock) → no config
        return frozenset()


def sender_scope(
    from_email: str,
    self_email: str,
    extra_domains: frozenset[str] | set[str] = frozenset(),
) -> str:
    """Classify a sender's provenance relative to the mailbox owner.

    Returns one of:
    - ``"self"``     — the owner's own address sent it (you personally).
    - ``"internal"`` — same email domain as the owner, or one of ``extra_domains``
      (your organisation, but not you).
    - ``"external"`` — anyone else.

    Fails SAFE to ``"external"`` on empty/garbage input, so we never suppress a
    genuine receive-category for mail we couldn't identify. ``self_email`` with no
    domain (shouldn't happen) yields same-domain matching off the empty string,
    i.e. only an exact ``self`` match counts.
    """
    frm = (from_email or "").strip().lower()
    me = (self_email or "").strip().lower()
    if not frm or "@" not in frm:
        return "external"
    if me and frm == me:
        return "self"
    own_domain = _domain_of(me)
    domains = {d for d in ({own_domain} | {
        (e or "").strip().lower().lstrip("@") for e in extra_domains}) if d}
    return "internal" if (_domain_of(frm) in domains) else "external"


def is_own_mail(
    from_email: str,
    self_email: str,
    extra_domains: frozenset[str] | set[str] = frozenset(),
) -> bool:
    """True when the sender is you or your organisation (``self``/``internal``) —
    i.e. NOT external mail you received from an outside party."""
    return sender_scope(from_email, self_email, extra_domains) != "external"
