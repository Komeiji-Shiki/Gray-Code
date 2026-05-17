from __future__ import annotations

from typing import Any

from ..types import ChatMessage, TaggedContent


def is_tagged_contents(v: Any) -> bool:
    return isinstance(v, list) and all(
        isinstance(x, dict) and ("tag" in x) and ("target" in x) and ("text" in x) for x in v
    )


def to_internal_from_tagged(input_value: list[TaggedContent]) -> list[ChatMessage]:
    return [{"role": m.get("role"), "parts": [{"text": (m.get("text") or "")}]} for m in (input_value or [])]


def from_internal_to_tagged(_internal: list[ChatMessage]) -> list[TaggedContent]:
    raise RuntimeError(
        "from_internal_to_tagged is not supported: tagged output should be produced by prompt assembly stage."
    )

