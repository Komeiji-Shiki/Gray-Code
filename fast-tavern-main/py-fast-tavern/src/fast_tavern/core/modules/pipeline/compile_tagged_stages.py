from __future__ import annotations

from typing import Any

from ...types import PerItemStages, TaggedContent
from .process_content_stages import process_content_stages


def compile_tagged_stages(tagged: list[TaggedContent], params: dict[str, Any]) -> dict[str, Any]:
    per_item: list[PerItemStages] = []

    raw = [dict(i) for i in (tagged or [])]
    after_pre_regex: list[TaggedContent] = []
    after_macro: list[TaggedContent] = []
    after_post_regex: list[TaggedContent] = []

    for item in raw:
        s = process_content_stages(
            item.get("text") or "",
            {
                "target": item.get("target"),
                "view": params.get("view"),
                "scripts": params.get("scripts") or [],
                "macros": params.get("macros") or {},
                "variableContext": params.get("variableContext"),
                "historyDepth": item.get("historyDepth"),
            },
        )

        per: PerItemStages = {
            "tag": item.get("tag"),
            "role": item.get("role"),
            "target": item.get("target"),
            **({"historyDepth": item.get("historyDepth")} if item.get("historyDepth") is not None else {}),
            "raw": s["raw"],
            "afterPreRegex": s["afterPreRegex"],
            "afterMacro": s["afterMacro"],
            "afterPostRegex": s["afterPostRegex"],
        }
        per_item.append(per)

        after_pre_regex.append({**item, "text": s["afterPreRegex"]})
        after_macro.append({**item, "text": s["afterMacro"]})
        after_post_regex.append({**item, "text": s["afterPostRegex"]})

    return {"stages": {"raw": raw, "afterPreRegex": after_pre_regex, "afterMacro": after_macro, "afterPostRegex": after_post_regex}, "perItem": per_item}

