"""Transport · templates — the approved template library (W1).

Backs the composer's `/` picker (what can I send when the 24h window is closed?)
and the standing rules that reach outside the window (payment chase, follow-up
nudge). Templates are authored + approved in Meta's dashboard; this mirrors the
catalog and seeds a sensible default set on connect so the rules have something
to reference from day one.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.whatsapp.core import _get_db, router
from pydantic import BaseModel
from sqlalchemy import text

_META_STATUSES = {"approved", "pending", "rejected"}
_META_CATEGORIES = {"UTILITY", "MARKETING", "AUTHENTICATION"}


class WhatsAppTemplateModel(BaseModel):
    id: str
    name: str
    language: str = "en"
    category: str = "UTILITY"
    body: str = ""
    variables: list[str] = []
    meta_status: str = "pending"
    cost_hint: str | None = None


class CreateTemplateRequest(BaseModel):
    name: str
    language: str = "en"
    category: str = "UTILITY"
    body: str = ""
    variables: list[str] = []
    meta_status: str = "pending"
    cost_hint: str | None = None


def default_templates() -> list[dict[str, Any]]:
    """The starter set the standing rules reference. Pure so it's unit-testable
    and identical across bootstrap paths. Seeded as 'pending' — Meta approval is
    out-of-band; the UI shows the state honestly until each is approved."""
    return [
        {
            "name": "payment_reminder",
            "language": "en",
            "category": "UTILITY",
            "body": "Hi {{1}}, a gentle reminder that invoice {{2}} "
                    "({{3}}) is currently outstanding. Could you have a look "
                    "when you get a chance? Thank you!",
            "variables": ["name", "invoice_no", "amount"],
            "cost_hint": "utility",
        },
        {
            "name": "follow_up_nudge",
            "language": "en",
            "category": "UTILITY",
            "body": "Hi {{1}}, just following up on {{2}} — no rush, "
                    "whenever you have a moment.",
            "variables": ["name", "subject"],
            "cost_hint": "utility",
        },
        {
            "name": "order_dispatched",
            "language": "en",
            "category": "UTILITY",
            "body": "Hi {{1}}, your order {{2}} has been dispatched. "
                    "Track it here: {{3}}",
            "variables": ["name", "order_no", "tracking_url"],
            "cost_hint": "utility",
        },
    ]


def _validate(req: CreateTemplateRequest) -> None:
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="template name required")
    if req.meta_status not in _META_STATUSES:
        raise HTTPException(status_code=400, detail="invalid meta_status")
    if req.category not in _META_CATEGORIES:
        raise HTTPException(status_code=400, detail="invalid category")


def _model(row: Any) -> WhatsAppTemplateModel:
    variables = row.variables
    if isinstance(variables, str):
        import json
        try:
            variables = json.loads(variables)
        except ValueError:
            variables = []
    return WhatsAppTemplateModel(
        id=str(row.id),
        name=row.name,
        language=row.language or "en",
        category=row.category or "UTILITY",
        body=row.body or "",
        variables=list(variables or []),
        meta_status=row.meta_status or "pending",
        cost_hint=row.cost_hint,
    )


async def _assert_account_owned(db: Any, account_id: str, user_email: str) -> None:
    owned = (await db.execute(
        text("SELECT 1 FROM wa_accounts WHERE id = :id AND user_id = :uid"),
        {"id": account_id, "uid": user_email},
    )).fetchone()
    if not owned:
        raise HTTPException(status_code=404, detail="Account not found")


@router.get("/templates", response_model=list[WhatsAppTemplateModel])
async def list_templates(
    account_id: str,
    approved_only: bool = False,
    user: UserContext = Depends(get_current_user),
):
    """List an account's templates. ``approved_only`` filters to what can send
    right now (what the composer's `/` picker offers when the window is closed)."""
    db = await _get_db()
    try:
        await _assert_account_owned(db, account_id, user.email or "anonymous")
        where = "account_id = :aid"
        params: dict[str, Any] = {"aid": account_id}
        if approved_only:
            where += " AND meta_status = 'approved'"
        rows = (await db.execute(
            text(f"""SELECT id, name, language, category, body, variables,
                            meta_status, cost_hint
                     FROM wa_templates WHERE {where}
                     ORDER BY name, language"""),
            params,
        )).fetchall()
        return [_model(r) for r in rows]
    finally:
        await db.close()


@router.post("/accounts/{account_id}/templates", response_model=WhatsAppTemplateModel,
             status_code=201)
async def create_template(
    account_id: str,
    req: CreateTemplateRequest,
    user: UserContext = Depends(get_current_user),
):
    """Register/mirror a single template (upsert on name+language)."""
    _validate(req)
    import json
    db = await _get_db()
    try:
        await _assert_account_owned(db, account_id, user.email or "anonymous")
        row = (await db.execute(
            text("""INSERT INTO wa_templates
                      (id, account_id, name, language, category, body,
                       variables, meta_status, cost_hint)
                    VALUES
                      (:id, :aid, :name, :lang, :cat, :body,
                       :vars, :status, :cost)
                    ON CONFLICT (account_id, name, language) DO UPDATE SET
                      category = EXCLUDED.category,
                      body = EXCLUDED.body,
                      variables = EXCLUDED.variables,
                      meta_status = EXCLUDED.meta_status,
                      cost_hint = EXCLUDED.cost_hint,
                      updated_at = now()
                    RETURNING id, name, language, category, body, variables,
                              meta_status, cost_hint"""),
            {"id": str(uuid4()), "aid": account_id, "name": req.name.strip(),
             "lang": req.language, "cat": req.category, "body": req.body,
             "vars": json.dumps(req.variables), "status": req.meta_status,
             "cost": req.cost_hint},
        )).fetchone()
        await db.commit()
        return _model(row)
    finally:
        await db.close()


@router.post("/accounts/{account_id}/templates/bootstrap",
             response_model=list[WhatsAppTemplateModel])
async def bootstrap_templates(
    account_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Seed the default template set for an account (idempotent — existing names
    are left untouched). Called once after connect so the rules have templates."""
    import json
    db = await _get_db()
    try:
        await _assert_account_owned(db, account_id, user.email or "anonymous")
        for t in default_templates():
            await db.execute(
                text("""INSERT INTO wa_templates
                          (id, account_id, name, language, category, body,
                           variables, meta_status, cost_hint)
                        VALUES
                          (:id, :aid, :name, :lang, :cat, :body,
                           :vars, 'pending', :cost)
                        ON CONFLICT (account_id, name, language) DO NOTHING"""),
                {"id": str(uuid4()), "aid": account_id, "name": t["name"],
                 "lang": t["language"], "cat": t["category"], "body": t["body"],
                 "vars": json.dumps(t["variables"]), "cost": t["cost_hint"]},
            )
        await db.commit()
        rows = (await db.execute(
            text("""SELECT id, name, language, category, body, variables,
                           meta_status, cost_hint
                    FROM wa_templates WHERE account_id = :aid
                    ORDER BY name, language"""),
            {"aid": account_id},
        )).fetchall()
        return [_model(r) for r in rows]
    finally:
        await db.close()
