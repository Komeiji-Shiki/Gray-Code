from __future__ import annotations

from typing import Any

from ..types import ChatMessage, MessagePart


def is_gemini_messages(v: Any) -> bool:
    return isinstance(v, list) and all(
        isinstance(x, dict) and ("role" in x) and ("parts" in x) and isinstance(x.get("parts"), list) for x in v
    )


def to_internal_from_gemini(input_value: list[ChatMessage]) -> list[ChatMessage]:
    out: list[ChatMessage] = []
    for m in input_value or []:
        if "parts" not in m:
            out.append({"role": str(m.get("role") or "user"), "parts": [{"text": str(m.get("content") or "")}]})
            continue
        out.append(
            {
                "role": str(m.get("role") or "user"),
                **({"name": m["name"]} if "name" in m and m.get("name") else {}),
                **({"swipeId": m["swipeId"]} if isinstance(m.get("swipeId"), int) else {}),
                "parts": [dict(p) for p in (m.get("parts") or [])],  # copy
                **({"swipes": m["swipes"]} if isinstance(m.get("swipes"), list) else {}),
            }
        )
    return out


def from_internal_to_gemini(internal: list[ChatMessage]) -> list[ChatMessage]:
    # internal is already `parts`-style
    return internal or []

