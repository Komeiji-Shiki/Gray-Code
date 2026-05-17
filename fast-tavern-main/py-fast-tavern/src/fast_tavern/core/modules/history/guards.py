from __future__ import annotations

from typing import Any


def is_chat_messages(v: Any) -> bool:
    if not isinstance(v, list):
        return False
    for m in v:
        if not isinstance(m, dict):
            return False
        if "role" not in m:
            return False
        has_parts = "parts" in m and isinstance(m.get("parts"), list)
        has_content = "content" in m and isinstance(m.get("content"), str)
        if not (has_parts or has_content):
            return False
    return True

