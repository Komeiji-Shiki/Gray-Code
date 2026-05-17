from __future__ import annotations

from typing import Any

from ...types import PerItemStages
from ..macro import replace_macros
from ..regex import apply_regex


def process_content_stages(text: str, params: dict[str, Any]) -> dict[str, str]:
    raw = "" if text is None else str(text)

    # new semantics: afterPreRegex kept for compatibility, equals raw
    after_pre_regex = raw

    after_macro = replace_macros(
        after_pre_regex,
        {"macros": params.get("macros") or {}, "variableContext": params.get("variableContext")},
    )

    after_post_regex = apply_regex(
        after_macro,
        {
            "scripts": params.get("scripts") or [],
            "target": params.get("target"),
            "view": params.get("view"),
            "macros": params.get("macros") or {},
            "historyDepth": params.get("historyDepth"),
        },
    )

    return {
        "raw": raw,
        "afterPreRegex": after_pre_regex,
        "afterMacro": after_macro,
        "afterPostRegex": after_post_regex,
    }

