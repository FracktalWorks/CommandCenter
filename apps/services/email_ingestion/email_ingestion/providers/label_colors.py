"""Shared label-colour palette.

Email providers each have their own native colour system for labels/categories:

* **Outlook** master categories use a fixed set of *preset* tokens
  (``preset0`` .. ``preset24``).
* **Gmail** user labels use an (allowed) ``backgroundColor`` / ``textColor``
  hex pair — arbitrary hex is rejected by the API, only values from a fixed
  palette are accepted.

To let one user choice round-trip to either provider we anchor on the Outlook
**preset token** as the canonical, provider-agnostic colour id and map each
preset to the nearest *allowed* Gmail colour pair.  The frontend ships the same
preset→hex table for rendering, so a Gmail label whose real colour we read back
maps to a preset and renders identically to an Outlook category.

All Gmail ``bg``/``text`` values below are members of Gmail's allowed label
palette; ``hex`` is the display swatch colour (used for rendering only).
"""

from __future__ import annotations

# preset token → {name, hex (display), gmail bg, gmail text}.  bg/text are from
# Gmail's allowed label-colour palette so a write never gets rejected.
PRESET_COLORS: dict[str, dict[str, str]] = {
    "preset0":  {"name": "Red",          "hex": "#E74C3C", "bg": "#fb4c2f", "text": "#ffffff"},
    "preset1":  {"name": "Orange",       "hex": "#E67E22", "bg": "#ffad47", "text": "#000000"},
    "preset2":  {"name": "Brown",        "hex": "#A0522D", "bg": "#a46a21", "text": "#ffffff"},
    "preset3":  {"name": "Yellow",       "hex": "#F1C40F", "bg": "#fad165", "text": "#000000"},
    "preset4":  {"name": "Green",        "hex": "#2ECC71", "bg": "#16a766", "text": "#ffffff"},
    "preset5":  {"name": "Teal",         "hex": "#1ABC9C", "bg": "#2da2bb", "text": "#ffffff"},
    "preset6":  {"name": "Olive",        "hex": "#9DAE2A", "bg": "#aa8831", "text": "#ffffff"},
    "preset7":  {"name": "Blue",         "hex": "#3498DB", "bg": "#4a86e8", "text": "#ffffff"},
    "preset8":  {"name": "Purple",       "hex": "#9B59B6", "bg": "#a479e2", "text": "#ffffff"},
    "preset9":  {"name": "Cranberry",    "hex": "#E91E8C", "bg": "#b65775", "text": "#ffffff"},
    "preset10": {"name": "Steel",        "hex": "#5D8AA8", "bg": "#6d9eeb", "text": "#ffffff"},
    "preset11": {"name": "Dark steel",   "hex": "#34699A", "bg": "#285bac", "text": "#ffffff"},
    "preset12": {"name": "Gray",         "hex": "#95A5A6", "bg": "#cccccc", "text": "#000000"},
    "preset13": {"name": "Dark gray",    "hex": "#707B7C", "bg": "#999999", "text": "#000000"},
    "preset14": {"name": "Black",        "hex": "#2C3E50", "bg": "#434343", "text": "#ffffff"},
    "preset15": {"name": "Dark red",     "hex": "#B03A2E", "bg": "#cc3a21", "text": "#ffffff"},
    "preset16": {"name": "Dark orange",  "hex": "#BA4A00", "bg": "#cf8933", "text": "#ffffff"},
    "preset17": {"name": "Dark brown",   "hex": "#6E2C00", "bg": "#7a4706", "text": "#ffffff"},
    "preset18": {"name": "Dark yellow",  "hex": "#B7950B", "bg": "#d5ae49", "text": "#000000"},
    "preset19": {"name": "Dark green",   "hex": "#1E8449", "bg": "#0b804b", "text": "#ffffff"},
    "preset20": {"name": "Dark teal",    "hex": "#117A65", "bg": "#0d3b44", "text": "#ffffff"},
    "preset21": {"name": "Dark olive",   "hex": "#6B7A1E", "bg": "#684e07", "text": "#ffffff"},
    "preset22": {"name": "Dark blue",    "hex": "#1F618D", "bg": "#1c4587", "text": "#ffffff"},
    "preset23": {"name": "Dark purple",  "hex": "#6C3483", "bg": "#41236d", "text": "#ffffff"},
    "preset24": {"name": "Dark cranberry", "hex": "#99235C", "bg": "#83334c", "text": "#ffffff"},
}

# Default preset when a name has no explicit colour (mirrors the frontend's
# deterministic fallback so an uncoloured label still gets a stable colour).
_PRESETS = list(PRESET_COLORS)


def is_preset(token: str | None) -> bool:
    return bool(token) and token in PRESET_COLORS


def preset_for_name(name: str) -> str:
    """Deterministic preset for a label name (stable across calls)."""
    return _PRESETS[sum(ord(ch) for ch in name) % len(_PRESETS)]


def gmail_color(preset: str) -> dict[str, str] | None:
    """Gmail ``{backgroundColor, textColor}`` for a preset token, or None."""
    entry = PRESET_COLORS.get(preset)
    if not entry:
        return None
    return {"backgroundColor": entry["bg"], "textColor": entry["text"]}


def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    v = value.lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    try:
        return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
    except ValueError:
        return (0, 0, 0)


def preset_from_gmail_bg(bg: str | None) -> str | None:
    """Map a Gmail label ``backgroundColor`` to the nearest preset token.

    Exact match first (Gmail returns the colour we set verbatim); otherwise the
    closest preset by RGB distance, so externally-coloured labels still resolve.
    """
    if not bg:
        return None
    bg = bg.lower()
    for preset, entry in PRESET_COLORS.items():
        if entry["bg"].lower() == bg:
            return preset
    target = _hex_to_rgb(bg)
    best, best_d = None, 1 << 30
    for preset, entry in PRESET_COLORS.items():
        r, g, b = _hex_to_rgb(entry["bg"])
        d = (r - target[0]) ** 2 + (g - target[1]) ** 2 + (b - target[2]) ** 2
        if d < best_d:
            best, best_d = preset, d
    return best
