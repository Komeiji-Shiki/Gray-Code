from __future__ import annotations

from typing import Any

from ..types import ChatMessage


def is_text_input(v: Any) -> bool:
    return isinstance(v, str) or (isinstance(v, list) and all(isinstance(x, str) for x in v))


def to_internal_from_text(input_value: str | list[str]) -> list[ChatMessage]:
    text = "\n".join(input_value) if isinstance(input_value, list) else (input_value or "")
    return [{"role": "user", "parts": [{"text": text}]}]


def from_internal_to_text(internal: list[ChatMessage]) -> str:
    out: list[str] = []
    for m in internal or []:
        if isinstance(m, dict) and "content" in m:
            out.append(str(m.get("content") or ""))
            continue
        parts = (m or {}).get("parts") or []
        out.append("".join((p.get("text") or "") for p in parts if isinstance(p, dict) and "text" in p))
    return "\n".join(out)

