from __future__ import annotations

from typing import Any

from ..types import ChatMessage


def is_openai_chat_messages(v: Any) -> bool:
    return isinstance(v, list) and all(
        isinstance(x, dict) and ("role" in x) and ("content" in x) and isinstance(x.get("content"), str) for x in v
    )


def to_internal_from_openai(input_value: list[ChatMessage]) -> list[ChatMessage]:
    out: list[ChatMessage] = []
    for m in input_value or []:
        role = "model" if str(m.get("role") or "") == "assistant" else str(m.get("role") or "user")
        out.append(
            {
                "role": role,
                **({"name": m["name"]} if "name" in m and m.get("name") else {}),
                **({"swipeId": m["swipeId"]} if isinstance(m.get("swipeId"), int) else {}),
                "parts": [{"text": str(m.get("content") if "content" in m else "") or ""}],
            }
        )
    return out


def from_internal_to_openai(internal: list[ChatMessage]) -> list[ChatMessage]:
    out: list[ChatMessage] = []
    for m in internal or []:
        role = "assistant" if str(m.get("role") or "user") == "model" else str(m.get("role") or "user")
        if "content" in m:
            content = str(m.get("content") or "")
        else:
            parts = (m.get("parts") or []) if isinstance(m, dict) else []
            content = "".join((p.get("text") or "") for p in parts if isinstance(p, dict) and "text" in p)
        out.append(
            {
                "role": role,
                **({"name": m["name"]} if "name" in m and m.get("name") else {}),
                **({"swipeId": m["swipeId"]} if isinstance(m.get("swipeId"), int) else {}),
                "content": content,
            }
        )
    return out

