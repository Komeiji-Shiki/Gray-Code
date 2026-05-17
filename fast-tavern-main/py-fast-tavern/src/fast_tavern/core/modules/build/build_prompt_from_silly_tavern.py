from __future__ import annotations

from typing import Any

from ...types import BuildPromptFromSillyTavernParams, BuildPromptResult
from ..inputs import (
    convert_character_from_silly_tavern,
    convert_history_from_silly_tavern,
    convert_preset_from_silly_tavern,
    convert_regexes_from_silly_tavern,
    convert_worldbooks_from_silly_tavern,
)
from .build_prompt import build_prompt


# 旧酒馆（SillyTavern 原始结构）包装入口：
# 1) 先把旧结构转换为 st-api-wrapper 新格式
# 2) 再执行 build_prompt

def build_prompt_from_silly_tavern(
    params: BuildPromptFromSillyTavernParams | dict[str, Any] | None = None,
    **kwargs: Any,
) -> BuildPromptResult:
    params = {**(params or {}), **kwargs}

    preset = convert_preset_from_silly_tavern(params.get("preset"))

    character = convert_character_from_silly_tavern(params.get("character")) if params.get("character") is not None else None

    globals_raw = params.get("globals") if isinstance(params.get("globals"), dict) else {}
    world_books = (
        convert_worldbooks_from_silly_tavern(globals_raw.get("worldBooks"))
        if "worldBooks" in globals_raw
        else None
    )
    regex_scripts = (
        convert_regexes_from_silly_tavern(globals_raw.get("regexScripts"))
        if "regexScripts" in globals_raw
        else None
    )

    history = convert_history_from_silly_tavern(params.get("history"))

    return build_prompt(
        {
            "preset": preset,
            "character": character,
            "globals": {
                "worldBooks": world_books,
                "regexScripts": regex_scripts,
            },
            "history": history,
            "view": params.get("view"),
            "outputFormat": params.get("outputFormat") if params.get("outputFormat") is not None else params.get("output_format"),
            "systemRolePolicy": params.get("systemRolePolicy") if params.get("systemRolePolicy") is not None else params.get("system_role_policy"),
            "macros": params.get("macros"),
            "variables": params.get("variables"),
            "globalVariables": params.get("globalVariables") if params.get("globalVariables") is not None else params.get("global_variables"),
            "options": params.get("options"),
        }
    )


# TS-style alias
buildPromptFromSillyTavern = build_prompt_from_silly_tavern

__all__ = ["build_prompt_from_silly_tavern", "buildPromptFromSillyTavern"]
