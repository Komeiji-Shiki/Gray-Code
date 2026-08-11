from __future__ import annotations

from typing import Any

from ..inputs import (
    convert_character_from_silly_tavern,
    convert_history_from_silly_tavern,
    convert_preset_from_silly_tavern,
    convert_regexes_from_silly_tavern,
    convert_worldbooks_from_silly_tavern,
)
from .build_prompt import _is_params_object, build_prompt


def build_prompt_from_silly_tavern(
    preset: Any = None,
    character: Any = None,
    globals: dict[str, Any] | None = None,
    history: list[Any] | None = None,
    view: str = "model",
    output_format: str = "gemini",
    system_role_policy: str = "keep",
    macros: dict[str, str] | None = None,
    variables: dict[str, Any] | None = None,
    global_variables: dict[str, Any] | None = None,
    options: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """
    旧酒馆（SillyTavern 原始结构）包装入口：
    先转换为新格式，再执行 build_prompt。
    """
    # 兼容 TS 风格：传入单个 params 对象（含 preset/history/view 等键）
    if _is_params_object(preset):
        params = preset
        preset = params.get("preset")
        character = params.get("character")
        globals = params.get("globals")
        history = params.get("history")
        view = params.get("view", "model")
        output_format = params.get("outputFormat", params.get("output_format", "gemini"))
        system_role_policy = params.get("systemRolePolicy", params.get("system_role_policy", "keep"))
        macros = params.get("macros")
        variables = params.get("variables")
        global_variables = params.get("globalVariables", params.get("global_variables"))
        options = params.get("options")

    output_format = kwargs.pop("outputFormat", output_format)
    system_role_policy = kwargs.pop("systemRolePolicy", system_role_policy)
    global_variables = kwargs.pop("globalVariables", global_variables)

    globals = globals or {}

    return build_prompt(
        preset=convert_preset_from_silly_tavern(preset),
        character=convert_character_from_silly_tavern(character) if character is not None else None,
        globals={
            "worldBooks": convert_worldbooks_from_silly_tavern(globals.get("worldBooks")),
            "regexScripts": convert_regexes_from_silly_tavern(globals.get("regexScripts")),
        },
        history=convert_history_from_silly_tavern(history),
        view=view,
        output_format=output_format,
        system_role_policy=system_role_policy,
        macros=macros,
        variables=variables,
        global_variables=global_variables,
        options=options,
    )


# TS-style alias
buildPromptFromSillyTavern = build_prompt_from_silly_tavern
