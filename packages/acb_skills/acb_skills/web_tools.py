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
        from ddgs import DDGS  # noqa: PLC0415
    except ImportError:
        try:
            from duckduckgo_search import DDGS  # noqa: PLC0415  # legacy name fallback
        except ImportError:
            return (
                "web_search is unavailable: the 'ddgs' package is not installed. "
                "Run: uv add ddgs"
            )

    max_results = max(1, min(10, int(max_results)))

    def _sync_search() -> list[dict]:
        with DDGS() as ddgs:
            return list(ddgs.text(query, max_results=max_results))

    try:
        results = await asyncio.to_thread(_sync_search)
    except Exception as exc:  # noqa: BLE001
        return f"web_search failed: {exc}"

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
        import httpx  # noqa: PLC0415
    except ImportError:
        return (
            "fetch_page is unavailable: the 'httpx' package is not installed. "
            "Run: uv add httpx"
        )

    if not url.startswith(("http://", "https://")):
        return f"fetch_page: invalid URL {url!r} — must start with http:// or https://"

    jina_url = f"https://r.jina.ai/{url}"
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
    except httpx.TimeoutException:
        return f"fetch_page timed out fetching: {url}"
    except httpx.HTTPStatusError as exc:
        return f"fetch_page HTTP {exc.response.status_code} for: {url}"
    except Exception as exc:  # noqa: BLE001
        return f"fetch_page failed: {exc}"

    if not text:
        return f"fetch_page: empty response for {url}"

    max_chars = max(500, int(max_chars))
    if len(text) > max_chars:
        text = text[:max_chars] + f"\n\n[... truncated at {max_chars} chars]"

    return text
