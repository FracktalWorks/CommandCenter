"""Entity resolution — WBS 1.2.

Cross-source dedupe / merge for the four entities that arrive from multiple
systems (Person, Customer, Project, Deal). Implements a deterministic-first
strategy that is fast, explainable, and safe to run every nightly cycle:

    1. Canonicalise the candidate (lowercase email, strip mailbox tags,
       normalise display name, strip company-suffix noise).
    2. Look for an exact match on any authoritative external id
       (zoho_id, clickup_id, odoo_id, email) — that wins outright.
    3. Fall back to a fuzzy match using Jaro–Winkler-style similarity over
       canonical_name + a domain prior (same email domain ⇒ +0.1 bonus).
    4. If the fuzzy score is above ``DETERMINISTIC_AUTO_MERGE`` we merge
       directly; between ``LLM_DELEGATE_MIN`` and that threshold we return a
       ``ResolutionCandidate`` with ``needs_llm=True`` so the caller can hand
       it to an LLM tiebreaker; below that we treat as a new entity.

The LLM fallback (`resolve_with_llm`) is deliberately stubbed to a deterministic
"reject" so unit tests run without a network. Wire it to `acb_llm.complete`
in the orchestrator layer where async + LiteLLM is available.

This module is pure-Python + SQLAlchemy: no network calls, no LLM in the hot
path. It is safe to run from the ingestion workers and the reconciler.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from acb_graph.models import Customer, Deal, Person, Project

# ---------- Tuning knobs ---------------------------------------------------

#: Names with similarity >= this number are merged without LLM review.
DETERMINISTIC_AUTO_MERGE: float = 0.92

#: Names with similarity in [LLM_DELEGATE_MIN, DETERMINISTIC_AUTO_MERGE) are
#: ambiguous and need a Tier-1 LLM tiebreaker. Below this we keep separate.
LLM_DELEGATE_MIN: float = 0.78

#: Generic public-mailbox domains that must NEVER provide a same-domain bonus
#: (otherwise random gmail users would all look like the same company).
_PUBLIC_DOMAINS: frozenset[str] = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "yahoo.com",
        "yahoo.co.in",
        "yahoo.co.uk",
        "outlook.com",
        "hotmail.com",
        "live.com",
        "icloud.com",
        "me.com",
        "protonmail.com",
        "proton.me",
        "aol.com",
        "msn.com",
        "rediffmail.com",
        "fastmail.com",
        "zoho.com",
    }
)

#: Strings to strip when canonicalising customer / company names.
_COMPANY_SUFFIXES: tuple[str, ...] = (
    " pvt ltd",
    " pvt. ltd",
    " pvt. ltd.",
    " private limited",
    " ltd",
    " ltd.",
    " limited",
    " llp",
    " llc",
    " inc",
    " inc.",
    " incorporated",
    " corp",
    " corp.",
    " corporation",
    " co",
    " co.",
    " company",
    " gmbh",
    " s.a.",
    " sa",
    " bv",
    " ag",
    " pte ltd",
    " plc",
)

_WHITESPACE_RE = re.compile(r"\s+")
_NONALNUM_RE = re.compile(r"[^a-z0-9]+")


# ---------- Canonicalisers --------------------------------------------------

def canonical_email(email: str | None) -> str | None:
    """Lowercase, trim, strip Gmail-style ``+tag`` mailbox extensions.

    Returns ``None`` for falsy / malformed input. Does NOT validate RFC 5321
    syntax — that's pydantic's job at the schema boundary.
    """
    if not email:
        return None
    s = email.strip().lower()
    if "@" not in s or s.startswith("@") or s.endswith("@"):
        return None
    local, _, domain = s.partition("@")
    # Strip "+anything" suffix from the local part (Gmail, FastMail, etc.)
    local = local.split("+", 1)[0]
    # Gmail ignores dots in the local part — collapse them for matching.
    if domain in {"gmail.com", "googlemail.com"}:
        local = local.replace(".", "")
        domain = "gmail.com"
    return f"{local}@{domain}"


def email_domain(email: str | None) -> str | None:
    """Lower-cased domain of ``email`` or ``None``."""
    canon = canonical_email(email)
    if canon is None:
        return None
    return canon.split("@", 1)[1]


def is_corporate_domain(domain: str | None) -> bool:
    """True if ``domain`` is not a generic public-mailbox provider."""
    if not domain:
        return False
    return domain not in _PUBLIC_DOMAINS


def canonical_name(name: str | None) -> str:
    """Normalise a person/customer display name for similarity comparison.

    - Unicode NFKD fold to strip accents.
    - Lowercase, collapse whitespace.
    - Drop common company suffixes (Pvt Ltd, Inc, LLC, ...).
    - Returns the empty string for falsy input (callers should guard).
    """
    if not name:
        return ""
    nfkd = unicodedata.normalize("NFKD", name)
    s = "".join(ch for ch in nfkd if not unicodedata.combining(ch)).strip().lower()
    s = _WHITESPACE_RE.sub(" ", s)
    for suffix in _COMPANY_SUFFIXES:
        if s.endswith(suffix):
            s = s[: -len(suffix)].rstrip()
            break
    return s


def _alphakey(name: str) -> str:
    """Aggressive lossy key: strip every non-alphanumeric, lowercase, for
    duplicate detection. ``"Acme, Inc."`` and ``"Acme Inc"`` both collapse to
    ``"acme"`` after `canonical_name`-stripping the suffix and then collapsing.
    """
    return _NONALNUM_RE.sub("", canonical_name(name))


# ---------- Similarity ------------------------------------------------------

def _jaro(s1: str, s2: str) -> float:
    """Plain Jaro similarity. Public-domain pseudo-code translated to Python.

    No external deps. For typical name lengths (< 50 chars) this is fast
    enough that we don't need ``python-Levenshtein``.
    """
    if s1 == s2:
        return 1.0 if s1 else 0.0
    len1, len2 = len(s1), len(s2)
    if len1 == 0 or len2 == 0:
        return 0.0
    match_window = max(len1, len2) // 2 - 1
    if match_window < 0:
        match_window = 0
    s1_matches = [False] * len1
    s2_matches = [False] * len2
    matches = 0
    for i, ch in enumerate(s1):
        start = max(0, i - match_window)
        end = min(i + match_window + 1, len2)
        for j in range(start, end):
            if s2_matches[j] or s2[j] != ch:
                continue
            s1_matches[i] = True
            s2_matches[j] = True
            matches += 1
            break
    if matches == 0:
        return 0.0
    # Count transpositions.
    k = 0
    transpositions = 0
    for i in range(len1):
        if not s1_matches[i]:
            continue
        while not s2_matches[k]:
            k += 1
        if s1[i] != s2[k]:
            transpositions += 1
        k += 1
    transpositions //= 2
    m = float(matches)
    return (m / len1 + m / len2 + (m - transpositions) / m) / 3.0


def jaro_winkler(s1: str, s2: str, *, prefix_scale: float = 0.1, max_prefix: int = 4) -> float:
    """Jaro–Winkler boosts Jaro by a per-character bonus for shared prefixes.

    ``prefix_scale`` capped at 0.25 by Winkler's original paper; we use the
    standard 0.1. ``max_prefix`` clamps the bonus to the first 4 chars so
    we don't reward an arbitrarily long common prefix.
    """
    j = _jaro(s1, s2)
    if j < 0.7:  # Winkler's threshold — only boost if Jaro is already strong.
        return j
    common = 0
    for a, b in zip(s1[:max_prefix], s2[:max_prefix]):
        if a != b:
            break
        common += 1
    return j + common * prefix_scale * (1.0 - j)


def name_similarity(a: str | None, b: str | None, *, domain_bonus: bool = False) -> float:
    """0..1 similarity over canonicalised display names.

    Set ``domain_bonus=True`` if the two records share the same *corporate*
    email domain — that adds 0.1 (clamped to 1.0). Public domains never
    grant the bonus.
    """
    ca, cb = canonical_name(a), canonical_name(b)
    if not ca or not cb:
        return 0.0
    if _alphakey(ca) == _alphakey(cb):
        # Identical after stripping punctuation/suffixes — treat as auto-merge.
        return 1.0
    score = jaro_winkler(ca, cb)
    if domain_bonus:
        score = min(1.0, score + 0.1)
    return score


# ---------- Resolution candidates ------------------------------------------

@dataclass(slots=True)
class ResolutionCandidate:
    """One possible existing match for an incoming entity."""

    entity_id: UUID
    score: float                 # 0..1
    reason: str                  # human-readable why
    needs_llm: bool = False      # caller should disambiguate via LLM


@dataclass(slots=True)
class ResolutionResult:
    """Outcome of resolve_*: either an existing id, or a new-entity verdict."""

    match: ResolutionCandidate | None
    candidates: list[ResolutionCandidate]   # all considered, best-first

    @property
    def is_match(self) -> bool:
        return self.match is not None

    @property
    def needs_llm(self) -> bool:
        return self.match is not None and self.match.needs_llm


def _verdict(candidates: list[ResolutionCandidate]) -> ResolutionResult:
    """Apply the auto-merge / LLM-delegate thresholds to ranked candidates."""
    candidates.sort(key=lambda c: c.score, reverse=True)
    if not candidates:
        return ResolutionResult(match=None, candidates=[])
    top = candidates[0]
    if top.score >= DETERMINISTIC_AUTO_MERGE:
        return ResolutionResult(match=top, candidates=candidates)
    if top.score >= LLM_DELEGATE_MIN:
        top.needs_llm = True
        return ResolutionResult(match=top, candidates=candidates)
    return ResolutionResult(match=None, candidates=candidates)


# ---------- Person resolution ----------------------------------------------

def resolve_person(
    session: Session,
    *,
    canonical_name_in: str | None = None,
    email: str | None = None,
    clickup_id: str | None = None,
    zoho_id: str | None = None,
    odoo_id: str | None = None,
    limit_fuzzy: int = 25,
) -> ResolutionResult:
    """Find the best existing Person row for the supplied attributes.

    Strategy:
      1. Authoritative-id match (clickup/zoho/odoo) — score 1.0, immediate.
      2. Canonical-email match — score 1.0, immediate.
      3. Name fuzzy match across at most ``limit_fuzzy`` recent rows that
         share the same email domain (or all rows if no email given), with
         a corporate-domain bonus baked into the score.

    Returns a :class:`ResolutionResult`. Use ``result.is_match`` to decide
    whether to upsert into the matched id or insert a fresh row.
    """
    # 1) External-id wins outright.
    for col, val in (
        (Person.clickup_id, clickup_id),
        (Person.zoho_id, zoho_id),
        (Person.odoo_id, odoo_id),
    ):
        if not val:
            continue
        hit = session.execute(select(Person).where(col == val)).scalar_one_or_none()
        if hit is not None:
            cand = ResolutionCandidate(
                entity_id=hit.id, score=1.0, reason=f"matched {col.key}={val}"
            )
            return ResolutionResult(match=cand, candidates=[cand])

    # 2) Canonical email is also authoritative for Person.
    canon = canonical_email(email)
    if canon is not None:
        hit = session.execute(
            select(Person).where(func.lower(Person.email) == canon)
        ).scalar_one_or_none()
        if hit is not None:
            cand = ResolutionCandidate(
                entity_id=hit.id, score=1.0, reason=f"matched email={canon}"
            )
            return ResolutionResult(match=cand, candidates=[cand])

    # 3) Fuzzy by name, restricted to plausible peers.
    if not canonical_name_in:
        return ResolutionResult(match=None, candidates=[])

    domain = email_domain(email)
    domain_bonus_active = is_corporate_domain(domain)

    stmt = select(Person)
    if domain_bonus_active:
        stmt = stmt.where(
            or_(
                func.lower(Person.email).like(f"%@{domain}"),
                Person.email.is_(None),
            )
        )
    stmt = stmt.order_by(Person.updated_at.desc()).limit(limit_fuzzy)
    rows = list(session.execute(stmt).scalars())

    candidates: list[ResolutionCandidate] = []
    for row in rows:
        same_corp = (
            domain_bonus_active
            and email_domain(row.email) == domain
        )
        score = name_similarity(
            canonical_name_in, row.canonical_name, domain_bonus=same_corp
        )
        if score >= LLM_DELEGATE_MIN:
            reason = (
                f"name '{row.canonical_name}' (jw={score:.2f}"
                + (", same corp domain" if same_corp else "")
                + ")"
            )
            candidates.append(
                ResolutionCandidate(entity_id=row.id, score=score, reason=reason)
            )
    return _verdict(candidates)


# ---------- Customer resolution --------------------------------------------

def resolve_customer(
    session: Session,
    *,
    name: str | None = None,
    zoho_id: str | None = None,
    odoo_id: str | None = None,
    primary_contact_email: str | None = None,
    limit_fuzzy: int = 50,
) -> ResolutionResult:
    """Find the best existing Customer row.

    Uses zoho_id / odoo_id as authoritative, then primary-contact corporate
    domain as a strong prior, then name similarity. Public-mailbox domains
    are ignored as a signal (gmail-only customers fall back to pure name).
    """
    for col, val in (
        (Customer.zoho_id, zoho_id),
        (Customer.odoo_id, odoo_id),
    ):
        if not val:
            continue
        hit = session.execute(select(Customer).where(col == val)).scalar_one_or_none()
        if hit is not None:
            cand = ResolutionCandidate(
                entity_id=hit.id, score=1.0, reason=f"matched {col.key}={val}"
            )
            return ResolutionResult(match=cand, candidates=[cand])

    if not name:
        return ResolutionResult(match=None, candidates=[])

    domain = email_domain(primary_contact_email)
    domain_bonus_active = is_corporate_domain(domain)

    rows = list(
        session.execute(
            select(Customer).order_by(Customer.updated_at.desc()).limit(limit_fuzzy)
        ).scalars()
    )
    candidates: list[ResolutionCandidate] = []
    for row in rows:
        score = name_similarity(name, row.name, domain_bonus=domain_bonus_active)
        if score >= LLM_DELEGATE_MIN:
            candidates.append(
                ResolutionCandidate(
                    entity_id=row.id,
                    score=score,
                    reason=f"name '{row.name}' (score={score:.2f})",
                )
            )
    return _verdict(candidates)


# ---------- Project / Deal name resolution (lightweight) -------------------

def resolve_by_name(
    session: Session,
    model: type[Project | Deal],
    name: str | None,
    *,
    limit_fuzzy: int = 50,
) -> ResolutionResult:
    """Generic fuzzy match for Project or Deal by ``name`` column.

    Use only when no external id is available (e.g. when an extractor sees a
    free-text reference in a meeting transcript).
    """
    if not name:
        return ResolutionResult(match=None, candidates=[])
    rows = list(
        session.execute(
            select(model).order_by(model.updated_at.desc()).limit(limit_fuzzy)
        ).scalars()
    )
    candidates: list[ResolutionCandidate] = []
    for row in rows:
        score = name_similarity(name, row.name)
        if score >= LLM_DELEGATE_MIN:
            candidates.append(
                ResolutionCandidate(
                    entity_id=row.id,
                    score=score,
                    reason=f"name '{row.name}' (score={score:.2f})",
                )
            )
    return _verdict(candidates)


# ---------- LLM tiebreaker (deferred) --------------------------------------

async def resolve_with_llm(
    *,
    incoming: dict[str, str | None],
    candidates: Iterable[ResolutionCandidate],
    candidate_summaries: dict[UUID, str],
) -> UUID | None:
    """Tier-1 LLM tiebreaker for ambiguous resolutions.

    The default implementation is a deterministic NO-OP that returns ``None``
    (keep separate). Wire to ``acb_llm.complete`` in the orchestrator layer
    where async + LiteLLM are available — keeping this module sync-friendly
    and easy to unit-test offline.

    A reference prompt template lives below; copy it into the orchestrator
    site when you implement the live call.
    """
    _ = (incoming, candidates, candidate_summaries)  # placeholder use
    return None


LLM_TIEBREAK_PROMPT = """\
You are an entity-resolution arbiter for the AI Company Brain. Decide whether
the INCOMING record refers to the SAME person/company as any of the
CANDIDATE records, or is a new entity.

Return strictly one of: an integer 1..N matching the chosen candidate, or 0
for "new entity". No prose.

INCOMING:
{incoming}

CANDIDATES:
{candidates}
"""


__all__ = [
    "DETERMINISTIC_AUTO_MERGE",
    "LLM_DELEGATE_MIN",
    "LLM_TIEBREAK_PROMPT",
    "ResolutionCandidate",
    "ResolutionResult",
    "canonical_email",
    "canonical_name",
    "email_domain",
    "is_corporate_domain",
    "jaro_winkler",
    "name_similarity",
    "resolve_by_name",
    "resolve_customer",
    "resolve_person",
    "resolve_with_llm",
]
