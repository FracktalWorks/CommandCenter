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

``extra_domains`` is the seam for the future "configure additional org domains /
aliases" setting; today callers pass none, so detection is same-domain only.
"""
from __future__ import annotations


def _domain_of(addr: str) -> str:
    addr = (addr or "").strip().lower()
    return addr.rsplit("@", 1)[1] if "@" in addr else ""


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
