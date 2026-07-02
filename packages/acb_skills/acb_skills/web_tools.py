"""Zero-credential web tools — auto-injected into every agent.

These tools require no API keys or integrations configuration.  They are
injected alongside the agent-delegation tools (call_agent, etc.) by
``orchestrator.executor._inject_agent_tools`` and are available to both
MAF agents and GitHub Copilot SDK agents automatically.

Tools
-----
web_search(query, max_results=5) -> str
    Search the web via DuckDuckGo.  No API key required.
    Returns up to *max_results* results as a plain-text block with title,
    URL, and a snippet for each hit.  Falls back to a clear error message
    if the duckduckgo-search package is not installed.

fetch_page(url, max_chars=8000) -> str
    Fetch any public web page and return it as clean, LLM-readable plain
    text via the Jina AI Reader proxy (https://r.jina.ai).  No key needed
    for reasonable request volumes.  Falls back gracefully if the request
    fails or httpx is unavailable.
"""
from __future__ import annotations

import asyncio


async def web_search(query: str, max_results: int = 5) -> str:
    """Search the web using DuckDuckGo and return the top results.

    Requires no API key.  Uses the ``duckduckgo-search`` Python library which
    queries DuckDuckGo directly.  Each result includes the page title, URL,
    and a short text snippet.

    Use this when you need current information, facts about a company or
    person, recent news, or anything that may not be in your training data.

    Args:
        query:       The search query string.
        max_results: Number of results to return (1-10).  Default 5.

    Returns:
        A plain-text block with one result per section, or an error message
        if the search could not be completed.

    Examples:
        info = await web_search("Fracktal Works 3D printing latest products")
        news = await web_search("GeM portal tender updates June 2025", max_results=3)
    """
    try:
        from ddgs import DDGS
    except ImportError:
        try:
            from duckduckgo_search import DDGS  # legacy name fallback
        except ImportError:
            return (
                "web_search is unavailable: the 'ddgs' package is not installed. "
                "Run: uv add ddgs"
            )

    max_results = max(1, min(10, int(max_results)))

    def _sync_search() -> list[dict]:
        # backend="auto" rotates across ddgs' engines (duckduckgo, bing,
        # brave, google, …) so one engine blocking the server's egress IP
        # doesn't take the tool down.
        with DDGS() as ddgs:
            return list(ddgs.text(query, max_results=max_results, backend="auto"))

    ddgs_error: str | None = None
    results: list[dict] = []
    try:
        results = await asyncio.to_thread(_sync_search)
    except Exception as exc:
        ddgs_error = f"{type(exc).__name__}: {exc}"

    if ddgs_error is not None or not results:
        # Fallback: SerpAPI (Google results), when a key is configured via
        # settings / the integrations key store. Keeps search alive when the
        # free engines block/ratelimit the deployment's egress IP.
        serp = await _serpapi_search(query, max_results)
        if isinstance(serp, list) and serp:
            results = serp
        elif ddgs_error is not None:
            hint = (
                " (both engine rotation and the SerpAPI fallback failed — "
                f"SerpAPI: {serp})" if isinstance(serp, str) and serp
                else " (no SERPAPI_API_KEY configured for the Google "
                     "fallback; the free engines may be blocking this "
                     "server's egress IP or an outbound proxy is denying "
                     "the request)"
            )
            return f"web_search failed: {ddgs_error}{hint}"

    if not results:
        return f"No results found for: {query!r}"

    lines: list[str] = [f"Web search results for: {query!r}\n"]
    for i, r in enumerate(results, 1):
        title = r.get("title", "(no title)")
        href = r.get("href", "")
        body = r.get("body", "").strip()
        lines.append(f"[{i}] {title}")
        lines.append(f"    URL: {href}")
        if body:
            lines.append(f"    {body[:300]}")
        lines.append("")

    return "\n".join(lines).strip()


async def _serpapi_search(query: str, max_results: int) -> list[dict] | str:
    """Google results via SerpAPI when a key is configured; else "".

    Returns a ddgs-shaped list of {title, href, body} dicts on success, or an
    error string ("" = no key configured, so nothing to report).
    """
    import os

    key = os.environ.get("SERPAPI_API_KEY", "")
    if not key:
        try:
            from acb_common import get_settings
            key = getattr(get_settings(), "serpapi_api_key", "") or ""
        except Exception:
            key = ""
    if not key:
        return ""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                "https://serpapi.com/search.json",
                params={"q": query, "num": max_results,
                        "engine": "google", "api_key": key},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"
    return [
        {
            "title": r.get("title", "(no title)"),
            "href": r.get("link", ""),
            "body": r.get("snippet", "") or "",
        }
        for r in (data.get("organic_results") or [])[:max_results]
    ]


async def fetch_page(url: str, max_chars: int = 8000) -> str:
    """Fetch a public web page and return its content as clean plain text.

    Uses the Jina AI Reader proxy (https://r.jina.ai/<url>) which strips
    navigation, ads, and HTML boilerplate and returns LLM-friendly markdown.
    No API key required for standard usage.

    Use this when you have a specific URL and need to read its contents —
    e.g. a company's About page, a product spec sheet, a news article, or
    a government tender page.

    Args:
        url:       The full URL to fetch (must include https:// or http://).
        max_chars: Truncate the response to this many characters.  Default 8000.

    Returns:
        The page content as plain text / markdown, truncated to *max_chars*.
        Returns an error message if the page could not be fetched.

    Examples:
        content = await fetch_page("https://fracktal.in/about")
        tender  = await fetch_page("https://gem.gov.in/tender/12345", max_chars=4000)
    """
    try:
        import httpx
    except ImportError:
        return (
            "fetch_page is unavailable: the 'httpx' package is not installed. "
            "Run: uv add httpx"
        )

    if not url.startswith(("http://", "https://")):
        return f"fetch_page: invalid URL {url!r} — must start with http:// or https://"

    jina_url = f"https://r.jina.ai/{url}"
    text = ""
    jina_error = ""
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(
                jina_url,
                headers={
                    "Accept": "text/plain",
                    "X-Return-Format": "markdown",
                },
            )
            resp.raise_for_status()
            text = resp.text.strip()
    except Exception as exc:
        jina_error = f"{type(exc).__name__}: {exc}"

    if not text:
        # Fallback: fetch the URL directly and strip HTML naively. Jina is
        # nicer output, but it must not be a single point of failure (it can
        # be blocked by an egress proxy or ratelimited).
        try:
            import re as _re
            async with httpx.AsyncClient(
                timeout=20.0, follow_redirects=True,
                headers={"User-Agent": "Mozilla/5.0 (CommandCenter fetch_page)"},
            ) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                raw = resp.text
            raw = _re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw)
            raw = _re.sub(r"(?s)<[^>]+>", " ", raw)
            text = _re.sub(r"[ \t]+", " ", raw)
            text = _re.sub(r"\n\s*\n+", "\n\n", text).strip()
        except Exception as exc:
            detail = f"{type(exc).__name__}: {exc}"
            return (
                f"fetch_page failed for {url} — Jina Reader: "
                f"{jina_error or 'empty response'}; direct fetch: {detail}"
            )

    if not text:
        return f"fetch_page: empty response for {url}"

    max_chars = max(500, int(max_chars))
    if len(text) > max_chars:
        text = text[:max_chars] + f"\n\n[... truncated at {max_chars} chars]"

    return text
