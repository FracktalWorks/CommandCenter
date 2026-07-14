"""write_artifact — agent tool for writing files to a session workspace.

Auto-injected into every agent alongside ``web_search`` and ``call_agent``.

The tool:
1. Defaults to the ``outputs/`` directory when no visible workspace dir
   (``inputs/``, ``outputs/``, ``agent-data/``) is specified in the path.
2. Writes the file under ``{workspace_root}/{path}`` (creating parent dirs).
3. Computes a SHA-256 hash of the content.
4. Emits an AG-UI ``CUSTOM`` event ``artifact_created`` / ``artifact_updated``
   so the Control Plane sidebar updates in real time.
5. PATCHes the gateway to register the workspace root on the session.
6. Returns a ``download_url`` the agent SHOULD embed in its text response.

Usage by agents:
    result = await write_artifact("summary.md", "# Sales Summary\\n...")
    # File lands in outputs/summary.md (auto-prefixed)
    # Agent outputs: [📄 Download summary.md]({download_url})
"""
from __future__ import annotations

import hashlib
import mimetypes
from datetime import UTC, datetime
from pathlib import Path

_WRITE_ARTIFACT_CONTEXT: dict[str, str] = {}
"""
Thread/coroutine-local store keyed by session_id, set by the executor
before each agent run::

    _WRITE_ARTIFACT_CONTEXT["session_id"] = session_id
    _WRITE_ARTIFACT_CONTEXT["workspace_root"] = "/tmp/acb_agents/repos/agent-sales-assistant"
    _WRITE_ARTIFACT_CONTEXT["gateway_url"] = "http://127.0.0.1:8000"
    _WRITE_ARTIFACT_CONTEXT["gateway_token"] = "sk-local-dev-..."

The executor clears this after each run.
"""

# Visible workspace dirs — files written outside these are hidden in the UI.
_VISIBLE_DIRS = frozenset({"inputs", "outputs", "agent-data"})


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _normalise_path(path: str) -> str:
    """Strip leading slashes/dots and ensure the path lives in a visible dir.

    If *path* doesn't start with ``inputs/``, ``outputs/``, or ``agent-data/``,
    it is automatically prefixed with ``outputs/`` so the file appears in the
    Files Viewer sidebar.

    NOTE: this only strips a LEADING ``/.`` — it does not neutralise an EMBEDDED
    ``..`` (e.g. ``outputs/../../etc/x``). Containment is enforced separately by
    :func:`resolve_in_workspace`; every tool that turns a caller path into a
    filesystem path MUST route it through that guard.
    """
    clean = path.replace("\\", "/").lstrip("/.")
    # Already in a visible dir — use as-is.
    for d in _VISIBLE_DIRS:
        if clean == d or clean.startswith(d + "/"):
            return clean
    # Default: write to outputs/
    return f"outputs/{clean}"


def resolve_in_workspace(root: str | Path, rel: str) -> Path | None:
    """Resolve *rel* under *root*, returning it ONLY if it stays inside the root.

    The single path-containment guard for every workspace read/write tool
    (``write_artifact``, ``save_note``, ``recall_notes``, …). Returns ``None`` on
    any traversal escape — an embedded ``..`` that climbs out, or an absolute
    path that resolves outside the workspace — so callers fail closed instead of
    reading/writing arbitrary files. Symlinks are resolved on both sides so a
    symlinked escape is caught too.
    """
    root_r = Path(root).resolve()
    # strict=False (the default): non-existent leaves still resolve lexically,
    # so a not-yet-created target is contained-checked correctly.
    target = (root_r / rel).resolve()
    try:
        target.relative_to(root_r)
    except ValueError:
        return None
    return target


async def write_artifact(
    path: str,
    content: str | bytes,
    *,
    encoding: str | None = "utf-8",
    overwrite: bool = False,
) -> dict:
    """Write a file to the agent's workspace and surface it in the UI file browser.

    Call this any time you generate a document, report, script, spreadsheet,
    PDF, image, or any other file that the operator should be able to view or
    download from the Control Plane.

    Files are automatically placed in ``outputs/`` unless you specify
    ``inputs/`` (user-provided files) or ``agent-data/`` (reference data).

    After calling this, **embed the returned ``download_url`` in your text
    response** so the operator can click to download.  Example::

        result = await write_artifact("q2_report.md", report_markdown)
        # In your response text, include:
        # [📄 Download Q2 Report]({result["download_url"]})

    Args:
        path:     Relative file path, e.g. ``"summary.md"`` or
                  ``"reports/q2_summary.md"``.  If the path does not start
                  with ``inputs/``, ``outputs/``, or ``agent-data/``, it is
                  automatically placed in ``outputs/``.
                  Parent directories are created automatically.
        content:  File content — either a ``str`` (written with *encoding*)
                  or ``bytes`` (written as-is; set *encoding* to ``None``).
        encoding: Text encoding for ``str`` content.  Default ``"utf-8"``.
                  Pass ``None`` when *content* is already ``bytes``.
        overwrite: By default (``False``) an existing file is **never**
                  clobbered — the new file is written to a uniquified name
                  (``report (1).md``) so originals/user uploads are preserved.
                  Set ``True`` to deliberately replace the file in place.

    Returns:
        ``{"path": str, "size": int, "sha256": str, "download_url": str}``

        ``path``/``download_url`` reflect the file *actually* written (which may
        be a uniquified name if a file already existed and ``overwrite`` is off).
        *download_url* is a relative URL suitable for a clickable markdown
        link, e.g. ``/api/agent/workspace/{session}/file?path=outputs/x.md``.
    """
    import asyncio

    workspace_root = _WRITE_ARTIFACT_CONTEXT.get("workspace_root")
    session_id = _WRITE_ARTIFACT_CONTEXT.get("session_id")
    gateway_url = _WRITE_ARTIFACT_CONTEXT.get("gateway_url", "http://127.0.0.1:8000")
    gateway_token = _WRITE_ARTIFACT_CONTEXT.get("gateway_token", "sk-local-dev-change-me")

    if not workspace_root:
        # Fallback: write to a temp dir per session
        import tempfile
        workspace_root = str(Path(tempfile.gettempdir()) / "acb_artifacts" / (session_id or "unknown"))
        _WRITE_ARTIFACT_CONTEXT["workspace_root"] = workspace_root

    root = Path(workspace_root)
    root_r = root.resolve()
    # Normalise path and auto-prefix with outputs/ if needed
    clean_path = _normalise_path(path)
    # Containment guard: refuse any path that escapes the workspace (embedded
    # ``..`` or an absolute path resolving outside root). Fail closed.
    target = resolve_in_workspace(root, clean_path)
    if target is None:
        return {"error": f"Path '{path}' escapes the workspace and was refused."}
    clean_path = target.relative_to(root_r).as_posix()

    # Ensure parent directory exists
    target.parent.mkdir(parents=True, exist_ok=True)

    # Non-destructive by default: never clobber an existing file (a user upload
    # in inputs/, or a previously generated artifact). Uniquify to "name (1).ext"
    # — the same collision policy the upload endpoint uses. Pass overwrite=True to
    # deliberately replace the file in place.
    if target.exists() and not overwrite:
        stem, ext = target.stem, target.suffix
        counter = 1
        while target.exists():
            target = target.parent / f"{stem} ({counter}){ext}"
            counter += 1
        clean_path = target.relative_to(root_r).as_posix()

    # Write file
    if isinstance(content, str):
        data = content.encode(encoding or "utf-8")
    else:
        data = bytes(content)

    target.write_bytes(data)
    digest = _sha256(data)
    size = len(data)

    mime, _ = mimetypes.guess_type(target.name)
    mime = mime or "application/octet-stream"

    # Build download URL (relative path — works from the frontend chat UI).
    download_url = (
        f"/api/agent/workspace/{session_id}/file"
        f"?path={clean_path}"
    ) if session_id else None

    # Build artifact entry
    artifact = {
        "path": clean_path,
        "name": target.name,
        "size": size,
        "sha256": digest,
        "mime_type": mime,
        "modified_at": datetime.now(tz=UTC).isoformat(),
        "is_dir": False,
    }

    # Fire-and-forget: emit AG-UI CUSTOM event into the active SSE stream
    # (via _active_run_queue context var set by the executor) and also
    # register the workspace path on the session via the gateway.
    asyncio.ensure_future(_notify(
        session_id=session_id,
        workspace_root=workspace_root,
        artifact=artifact,
        gateway_url=gateway_url,
        gateway_token=gateway_token,
    ))

    result: dict = {"path": clean_path, "size": size, "sha256": digest}
    if download_url:
        result["download_url"] = download_url
    return result


async def share_artifact(path: str) -> dict:
    """Surface a file you ALREADY created as a downloadable, previewable card in
    the chat — and get back a download link.

    Use this whenever you produced a file with your own tools (shell, editor,
    Write, a script you ran) instead of ``write_artifact``.  Do NOT re-create or
    re-read the file's contents — just point this tool at the path you already
    wrote and it will appear in the chat with a Download button and an inline
    preview, with zero extra effort on your part.  You do not need to construct
    any URL by hand; the returned ``download_url`` is the canonical link.

    Pass a single file, or a directory to share every file inside it.

    Args:
        path: File or directory path relative to your workspace (e.g.
              ``"outputs/report.pdf"``, ``"q2_summary.xlsx"``, or ``"outputs"``
              to share the whole folder).  Absolute paths inside the workspace
              are also accepted.

    Returns:
        ``{"artifacts": [{"path","name","size","mime_type","download_url"}, ...],
        "download_url": <first file's link>}``.  On error,
        ``{"error": str, "artifacts": []}``.
    """
    import asyncio

    workspace_root = _WRITE_ARTIFACT_CONTEXT.get("workspace_root")
    session_id = _WRITE_ARTIFACT_CONTEXT.get("session_id")
    gateway_url = _WRITE_ARTIFACT_CONTEXT.get("gateway_url", "http://127.0.0.1:8000")
    gateway_token = _WRITE_ARTIFACT_CONTEXT.get("gateway_token", "sk-local-dev-change-me")

    if not workspace_root:
        return {"error": "No workspace is configured for this run.", "artifacts": []}

    root = Path(workspace_root).resolve()
    raw = (path or "").replace("\\", "/").strip().lstrip("/")
    if not raw:
        return {"error": "A file or directory path is required.", "artifacts": []}
    candidate = Path(raw)
    target = (candidate if candidate.is_absolute() else root / raw).resolve()

    # Path-traversal guard — the target must stay inside the workspace root.
    try:
        target.relative_to(root)
    except ValueError:
        return {"error": f"Path '{path}' is outside the workspace.", "artifacts": []}
    if not target.exists():
        return {"error": f"File not found: {path}", "artifacts": []}

    # Collect the file(s) to share (a directory shares everything within it).
    files: list[Path] = []
    if target.is_dir():
        for p in sorted(target.rglob("*")):
            if p.is_file():
                files.append(p)
                if len(files) >= 50:
                    break
    else:
        files = [target]
    if not files:
        return {"error": f"No files found at: {path}", "artifacts": []}

    artifacts: list[dict] = []
    for f in files:
        rel = f.resolve().relative_to(root).as_posix()
        size = f.stat().st_size
        mime, _ = mimetypes.guess_type(f.name)
        mime = mime or "application/octet-stream"
        download_url = (
            f"/api/agent/workspace/{session_id}/file?path={rel}"
            if session_id else None
        )
        art = {
            "path": rel,
            "name": f.name,
            "size": size,
            "mime_type": mime,
            "modified_at": datetime.now(tz=UTC).isoformat(),
            "is_dir": False,
        }
        # Same CUSTOM event write_artifact emits → renders the ArtifactCard.
        asyncio.ensure_future(_notify(
            session_id=session_id,
            workspace_root=workspace_root,
            artifact=art,
            gateway_url=gateway_url,
            gateway_token=gateway_token,
        ))
        entry: dict = {"path": rel, "name": f.name, "size": size, "mime_type": mime}
        if download_url:
            entry["download_url"] = download_url
        artifacts.append(entry)

    result: dict = {"artifacts": artifacts}
    if artifacts and artifacts[0].get("download_url"):
        result["download_url"] = artifacts[0]["download_url"]
    return result


async def _notify(
    *,
    session_id: str | None,
    workspace_root: str,
    artifact: dict,
    gateway_url: str,
    gateway_token: str,
) -> None:
    """Background task: push CUSTOM SSE event into the active run queue AND
    register workspace on the gateway.  Non-fatal — all errors are swallowed.
    """
    # 1. Push AG-UI CUSTOM event into the active executor SSE queue so the
    #    frontend receives it immediately as part of the existing chat stream.
    #    resolve_run_queue falls back to the plain _RUN_QUEUES registry (keyed
    #    by session_id) so this reaches the chat stream even for Copilot-SDK
    #    tools whose fresh-context thread can't see the ContextVar.
    try:
        from orchestrator.executor import resolve_run_queue
        queue = resolve_run_queue(session_id)
        if queue is not None:
            _artifact_data = {
                "path": artifact["path"],
                "sha256": artifact.get("sha256"),
                "size": artifact.get("size"),
                "mime_type": artifact.get("mime_type"),
            }
            await queue.put({
                "type": "CUSTOM",
                "name": "artifact_created",
                "value": _artifact_data,
            })
    except Exception:
        pass

    if not session_id:
        return

    # 2. Also POST to gateway events endpoint so any other SSE subscribers
    #    (future browser tabs, monitoring) receive it.
    try:
        import httpx

        headers = {
            "Authorization": f"Bearer {gateway_token}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=5) as client:
            # Register workspace root on the session (idempotent PATCH)
            await client.patch(
                f"{gateway_url}/agent/workspace/{session_id}",
                json={"workspace_path": workspace_root},
                headers=headers,
            )
            # Emit to gateway subscriber queues
            await client.post(
                f"{gateway_url}/agent/workspace/{session_id}/events",
                json={
                    "name": "artifact_created",
                    "path": artifact["path"],
                    "sha256": artifact.get("sha256"),
                    "size": artifact.get("size"),
                },
                headers=headers,
            )
    except Exception:
        pass  # Non-fatal — the sidebar can always refresh manually


# ── Generative UI ───────────────────────────────────────────────────────────

# The component types the frontend GenerativeUINode renderer whitelists. Kept in
# sync with GenerativeUINode.tsx KNOWN_TYPES so the tool's docstring can steer
# the model toward valid trees (and we can reject obviously-wrong ones early).
_GEN_UI_TYPES = {
    "card", "stack", "row", "heading", "text", "markdown", "badge",
    "divider", "keyValue", "table", "list", "code", "link", "button", "callout",
}


async def emit_generative_ui(ui: str) -> dict:
    """Render a rich, interactive, animated UI element inline in the chat, on the fly.

    Use this whenever a visual answer beats prose — a weather card, a KPI
    dashboard, a chart, a comparison, a status tracker, or a bespoke animated
    widget. ``ui`` is a JSON object (string or dict). It supports THREE modes;
    prefer them in this order (template → tree → html):

    1. NAMED TEMPLATE — pre-designed, animated, on-brand components. You supply
       ONLY data; the design is fixed and looks great every time. Use first when
       one fits. Shape: ``{"type":"template","props":{"name":<t>,"data":{...}}}``.
       Available templates and their ``data`` shapes:
         • weatherCard — {location, tempC|tempF, condition('sunny'|'cloudy'|
             'rain'|'snow'|'storm'), highC?, lowC?, humidity?, wind?,
             forecast?:[{day,condition,high,low}]}
         • statDashboard — {title?, stats:[{label, value, unit?, delta?:number}]}
         • barChart — {title?, unit?, bars:[{label, value,
             tone?('primary'|'success'|'warning'|'danger')}]}
         • sparkTrend — {label, value, unit?, delta?:number, series:number[]}
         • comparison — {title?, options:[{name, recommended?:bool,
             rows:[{label, value}]}]}
         • progressTracker — {title?, steps:[{label,
             state('done'|'active'|'pending')}]}

    2. COMPONENT TREE — a safe whitelist of typed primitives (data, not code).
       Each node is ``{"type":<kind>,"props":{...},"children":[...]}``. Kinds:
         card{title?} · stack · row · heading{text} · text{text,muted?} ·
         markdown{text} · badge{text,tone?} · divider · callout{title?,text?,tone?}
         keyValue{pairs:[{key,value}]} · table{columns:[..],rows:[[..]]} ·
         list{items:[..],ordered?} · code{text} · link{href,text?} ·
         button{label,action,tone?} ·
         icon{name,size?,tone?,label?}
       ``icon`` renders any Lucide icon by ``name`` (kebab or Pascal, e.g.
       ``"cloud-sun"``, ``"CheckCircle"``, ``"trending-up"``) — on-brand, bundled,
       no network; unknown names fall back to a neutral glyph. Put an ``icon`` in
       a ``row`` beside ``text`` for labelled rows. ``tone`` ∈ success|error|
       warning|info|neutral (badges/callouts/icons) or primary|danger|default
       (buttons). A ``button``'s ``action`` string is sent back as the user's
       next message when clicked.

    3. CUSTOM HTML — the escape hatch for bespoke animation/layout no template or
       tree covers. Shape: ``{"type":"html","props":{"code":"<div>…</div>"}}``.
       Your HTML/CSS/JS runs in an ISOLATED sandbox (its own opaque origin): it
       cannot reach the app, cookies, or the network, so inline everything — NO
       external CDNs, fonts, or images (use data: URIs). Optional
       ``props.height`` (px); omit to auto-size. For interactivity, put
       ``data-cc-action="<follow-up message>"`` on a clickable element (or call
       ``ccAction("…")`` from your script); it's delivered as the user's next
       message, exactly like a tree button's ``action``.

    Returns ``{"ok": true}`` on emit. Additive — also say in prose what you're
    showing. Keep template/tree/html discriminated by the top-level ``type``.

    Examples::

        # Template (preferred)
        await emit_generative_ui('{"type":"template","props":{"name":"weatherCard",'
          '"data":{"location":"Lisbon","tempC":24,"condition":"sunny","highC":26,'
          '"lowC":18,"humidity":40,"forecast":[{"day":"Mon","condition":"sunny",'
          '"high":25,"low":17},{"day":"Tue","condition":"rain","high":21,"low":15}]}}}')

        # Component tree
        await emit_generative_ui('{"type":"card","props":{"title":"Deploy"},'
          '"children":[{"type":"keyValue","props":{"pairs":['
          '{"key":"Status","value":"green"},{"key":"Version","value":"1.4.2"}]}},'
          '{"type":"row","children":[{"type":"button","props":'
          '{"label":"Roll back","action":"roll back the deploy","tone":"danger"}}]}]}')

        # Custom HTML (only when nothing above fits)
        await emit_generative_ui('{"type":"html","props":{"code":'
          '"<div style=\\'font:600 20px sans-serif;padding:16px\\'>Hi<button '
          'data-cc-action=\\'tell me more\\'>More</button></div>"}}')
    """
    import json

    try:
        spec = json.loads(ui) if isinstance(ui, str) else ui
    except (json.JSONDecodeError, TypeError) as exc:
        return {"ok": False, "error": f"ui must be valid JSON: {exc}"}
    if not isinstance(spec, dict):
        return {"ok": False, "error": "ui must be a JSON object (a component node)"}

    # Push the CUSTOM event into the active run's SSE queue. resolve_run_queue
    # tries the ContextVar (native-MAF) first, then the plain _RUN_QUEUES
    # registry keyed by the session id — the latter is what makes this work for
    # GitHub-Copilot-SDK agents, whose tool callables run in a JSON-RPC read
    # thread with a fresh context where the ContextVar is invisible.
    try:
        from orchestrator.executor import resolve_run_queue
        session_id = _WRITE_ARTIFACT_CONTEXT.get("session_id")
        queue = resolve_run_queue(session_id)
        if queue is not None:
            await queue.put({
                "type": "CUSTOM",
                "name": "generative_ui",
                "value": spec,
            })
            return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": False, "error": "no active run stream to render into"}
