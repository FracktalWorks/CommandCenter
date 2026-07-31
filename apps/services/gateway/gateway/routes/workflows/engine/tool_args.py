"""Typed tool arguments — the one place the ``args_schema`` mini-language lives.

A tool spec declares its arguments as ``{"list_id": "string", "headers":
"object?|Extra request headers"}``. That string is the whole contract, and it
had exactly one consumer: nothing. The catalog served it, the inspector showed
a raw JSON box, and the first time a missing ``list_id`` mattered was at 3am
inside a published run.

This module makes the declaration load-bearing in three places at once:

- the **editor** renders one typed field per argument (parsed server-side, so
  the browser never re-implements the mini-language),
- **publish** refuses a graph whose tool node omits a required argument, and
- the **runtime** fails the node closed rather than handing a malformed payload
  to an integration.

It lives in ``engine/`` because ``engine.graph`` must validate without importing
``routes.workflows.tools`` (which imports back out of the engine). Pure data in,
pure findings out — no registry, no transport.

Grammar (deliberately tiny — a JSON-Schema dialect would be a second type
system to maintain):

    <type>[?][|<description>]

``?`` marks the argument optional; everything after ``|`` is help text shown in
the editor. Unknown type names degrade to ``string`` rather than raising: a
malformed declaration must not take down the catalog for every other tool.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: The closed type vocabulary. Anything else is a typo, and is read as a string.
ARG_TYPES = frozenset({"string", "number", "boolean", "object", "array"})

DEFAULT_ARG_TYPE = "string"


@dataclass(frozen=True, slots=True)
class ArgSpec:
    name: str
    type: str
    required: bool
    description: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "type": self.type,
            "required": self.required,
            "description": self.description,
        }


def parse_arg_spec(name: str, raw: Any) -> ArgSpec:
    """One ``"object?|Extra headers"`` declaration → a typed ArgSpec."""
    text = str(raw or DEFAULT_ARG_TYPE)
    type_part, _, description = text.partition("|")
    type_part = type_part.strip()
    required = not type_part.endswith("?")
    type_name = type_part.rstrip("?").strip().lower() or DEFAULT_ARG_TYPE
    if type_name not in ARG_TYPES:
        type_name = DEFAULT_ARG_TYPE
    return ArgSpec(
        name=name,
        type=type_name,
        required=required,
        description=description.strip(),
    )


def parse_args_schema(schema: dict[str, Any] | None) -> list[ArgSpec]:
    """A whole ``args_schema`` dict → ArgSpecs, required ones first.

    Ordering is the editor's field order: what you must fill in comes before
    what you may.
    """
    specs = [parse_arg_spec(name, raw) for name, raw in (schema or {}).items()]
    return sorted(specs, key=lambda s: (not s.required, s.name))


def is_reference(value: Any) -> bool:
    """Whether a value defers to run time (``{{trigger.body}}``).

    A reference can resolve to any type, so it is exempt from static type
    checking — but NOT from the required check: writing a reference is how a
    maker satisfies a required argument.
    """
    return isinstance(value, str) and "{{" in value


def _is_blank(value: Any) -> bool:
    if value is None:
        return True
    return isinstance(value, str) and not value.strip()


def _type_matches(type_name: str, value: Any) -> bool:
    """Lenient on purpose: only obvious category errors are reported.

    A number written into a string field is coerced happily by every handler we
    have; a dict written into one is a mistake worth naming. Flagging the first
    would train makers to ignore the second.
    """
    if type_name == "object":
        return isinstance(value, dict)
    if type_name == "array":
        return isinstance(value, list)
    if type_name == "boolean":
        return isinstance(value, bool)
    # string / number: anything scalar is fine, a container is not.
    return not isinstance(value, (dict, list))


def check_args(
    schema: dict[str, Any] | None,
    args: Any,
    *,
    action: str = "this tool",
) -> list[str]:
    """Problems with *args* against *schema*, phrased for the maker.

    Empty list = usable. Deliberately reports EVERY problem rather than the
    first, so one publish attempt surfaces the whole fix list.
    """
    if args is None:
        args = {}
    if not isinstance(args, dict):
        return [f"arguments for {action} must be a JSON object"]

    declared = {spec.name: spec for spec in parse_args_schema(schema)}
    problems: list[str] = []

    for spec in declared.values():
        if spec.required and _is_blank(args.get(spec.name)):
            problems.append(f"'{spec.name}' is required by {action}")

    for key, value in args.items():
        spec = declared.get(key)
        if spec is None:
            problems.append(f"'{key}' is not an argument of {action}")
        elif (
            not is_reference(value)
            and not _is_blank(value)
            and not _type_matches(spec.type, value)
        ):
            problems.append(f"'{key}' should be {spec.type}")

    return problems
