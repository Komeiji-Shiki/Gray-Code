from __future__ import annotations

from typing import Any

from ...convert import convert_messages_in, convert_messages_out
from ...types import ChatMessage, TaggedContent, WorldBookEntry
from ..assemble import assemble_tagged_prompt_list
from ..inputs import (
    convert_character_from_silly_tavern,
    convert_history_from_silly_tavern,
    convert_preset_from_silly_tavern,
    convert_regexes_from_silly_tavern,
    convert_worldbooks_from_silly_tavern,
    normalize_regexes,
    normalize_worldbooks,
)
from ..pipeline.compile_tagged_stages import compile_tagged_stages
from ..variables import create_variable_context
from ..worldbook import get_active_entries


def _pick(params: dict[str, Any], snake: str, camel: str) -> Any:
    """同时兼容 snake_case 与 camelCase 键（snake_case 优先）。"""
    if snake in params:
        return params[snake]
    return params.get(camel)


def _to_internal(stage: list[TaggedContent] | None) -> list[ChatMessage]:
    """TaggedContent[] -> 内部 ChatMessage[]（parts 格式，对齐 TS toInternal）"""
    out: list[ChatMessage] = []
    for m in stage or []:
        out.append({"role": m.get("role"), "parts": [{"text": str(m.get("text") or "")}]})
    return out


def _apply_system_role_policy(internal: list[ChatMessage], policy: str) -> list[ChatMessage]:
    """systemRolePolicy='to_user' 时把 system 降级为 user；'keep' 原样返回。"""
    if policy == "keep":
        return internal
    return [dict(m, role="user") if str(m.get("role")) == "system" else m for m in (internal or [])]


def _extract_history_text(m: Any) -> str:
    """对齐 TS extractHistoryText：
    - parts 数组：逐 part 取 text（非 text part 视为空串），过滤空串后以 \\n 拼接
    - 否则取 content（None 视为缺失 -> ''，0/False 等保留）
    """
    if isinstance(m, str):
        return m
    if isinstance(m, dict):
        if isinstance(m.get("parts"), list):
            texts: list[str] = []
            for p in m.get("parts") or []:
                if isinstance(p, dict) and "text" in p:
                    texts.append(str(p.get("text") or ""))
                else:
                    texts.append("")
            return "\n".join(t for t in texts if t)
        if "content" in m:
            value = m.get("content")
            return "" if value is None else str(value)
    return ""


def build_prompt(params: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    """
    构建 Prompt（现代新格式输入），对齐 TS buildPrompt：

    流程：世界书归一化+激活（contextText=最近 N 条历史文本）-> 正则合并 ->
    历史转内部 parts -> Role + text（historyDepth 从末尾计数，0=最后一条）-> assemble 组装
    tagged.raw -> compile_tagged_stages（view/scripts/macros/variableContext）-> internal
    （parts 格式）-> output（tagged 直接返回 tagged 阶段；其它 convert_messages_out 转换，
    systemRolePolicy='to_user' 时 system -> user）。

    支持 snake_case 与 camelCase 两种关键字（output_format/outputFormat、
    system_role_policy/systemRolePolicy、global_variables/globalVariables）。
    """
    p: dict[str, Any] = dict(params or {})
    p.update(kwargs)

    preset: dict[str, Any] = p.get("preset") or {}
    character: dict[str, Any] | None = p.get("character")
    globals_: dict[str, Any] = p.get("globals") or {}
    history = p.get("history")
    if history is None:
        history = []
    if isinstance(history, str):
        history = [history]
    view: str | None = p.get("view")
    # 对齐 TS 解构默认值：仅 None/缺失才回退默认（空串等显式值保留）
    output_format = _pick(p, "output_format", "outputFormat")
    if output_format is None:
        output_format = "gemini"
    system_role_policy = _pick(p, "system_role_policy", "systemRolePolicy")
    if system_role_policy is None:
        system_role_policy = "keep"
    macros: dict[str, str] = p.get("macros") or {}
    variables = _pick(p, "variables", "variables")
    global_variables = _pick(p, "global_variables", "globalVariables")
    options: dict[str, Any] = p.get("options") or {}

    # 1) 世界书：多形态归一化 + 激活（contextText 取最近几条历史文本，默认 5）
    world_books_normalized: list[WorldBookEntry] = (
        normalize_worldbooks(globals_.get("worldBooks")) if globals_.get("worldBooks") else []
    )
    # 对齐 TS options?.recentHistoryForWorldbook ?? 5：显式 None 同样回退默认
    recent_history_for_worldbook = options.get("recentHistoryForWorldbook")
    if recent_history_for_worldbook is None:
        recent_history_for_worldbook = 5
    context_text = "\n".join(
        t for t in (_extract_history_text(m) for m in (history or [])[-recent_history_for_worldbook:]) if t
    )

    active_worldbook_entries = get_active_entries(
        {
            "contextText": context_text,
            "globalEntries": world_books_normalized,
            "characterWorldBook": (character or {}).get("worldBook") if character else None,
            "options": {
                "vectorSearch": options.get("vectorSearch"),
                "recursionLimit": options.get("recursionLimit"),
                "rng": options.get("rng"),
                "defaultCaseSensitive": options.get("defaultCaseSensitive"),
            },
        }
    )

    # 2) 正则：global + preset + character 合并归一化
    merged_regex_scripts: list[dict[str, Any]] = []
    if globals_.get("regexScripts"):
        merged_regex_scripts.extend(normalize_regexes(globals_.get("regexScripts")))
    merged_regex_scripts.extend(preset.get("regexScripts") or [])
    if character:
        merged_regex_scripts.extend(character.get("regexScripts") or [])

    # 3) 历史：统一为内部 parts 格式，再转 Role + text（historyDepth 从末尾计数，0=最后一条）
    history_internal: list[ChatMessage] = convert_messages_in(history, "auto")["internal"]
    chat_history: list[dict[str, Any]] = []
    for idx, m in enumerate(history_internal):
        role = "model" if str(m.get("role")) == "assistant" else str(m.get("role"))
        chat_history.append(
            {
                "role": role,
                "text": _extract_history_text(m),
                "historyDepth": len(history_internal) - 1 - idx,
            }
        )

    # 4) 组装 tagged.raw（relative 骨架 + 插槽条目 + fixed 注入）
    tagged_raw: list[TaggedContent] = assemble_tagged_prompt_list(
        {
            "presetPrompts": preset.get("prompts") or [],
            "activeEntries": active_worldbook_entries,
            "chatHistory": chat_history,
            "positionMap": options.get("positionMap"),
        }
    )

    # 5) 阶段管道（宏 + 正则），产出 tagged 四阶段与 perItem
    # 变量上下文：setvar/getvar 宏就地写入 context，最终状态随结果返回
    variable_context = create_variable_context(variables, global_variables)
    compiled = compile_tagged_stages(
        tagged_raw,
        {
            "view": view,
            "scripts": merged_regex_scripts,
            "macros": macros,
            "variableContext": variable_context,
        },
    )
    tagged_stages = compiled["stages"]
    per_item = compiled["perItem"]

    # 6) internal（parts 格式，role: system/user/model）
    internal_stages = {
        "raw": _to_internal(tagged_stages["raw"]),
        "afterPreRegex": _to_internal(tagged_stages["afterPreRegex"]),
        "afterMacro": _to_internal(tagged_stages["afterMacro"]),
        "afterPostRegex": _to_internal(tagged_stages["afterPostRegex"]),
    }

    # 7) output：按 output_format 转换（tagged 无法逆向，直接返回 tagged 阶段）
    if output_format == "tagged":
        output_stages = {
            "raw": tagged_stages["raw"],
            "afterPreRegex": tagged_stages["afterPreRegex"],
            "afterMacro": tagged_stages["afterMacro"],
            "afterPostRegex": tagged_stages["afterPostRegex"],
        }
    else:
        # 对齐 TS：text -> text；openai -> openai；其余（含 gemini）-> gemini
        conv_format = "text" if output_format == "text" else "openai" if output_format == "openai" else "gemini"

        def conv(stage: list[ChatMessage]):
            return convert_messages_out(_apply_system_role_policy(stage, system_role_policy), conv_format)  # type: ignore[arg-type]

        output_stages = {
            "raw": conv(internal_stages["raw"]),
            "afterPreRegex": conv(internal_stages["afterPreRegex"]),
            "afterMacro": conv(internal_stages["afterMacro"]),
            "afterPostRegex": conv(internal_stages["afterPostRegex"]),
        }

    return {
        "outputFormat": output_format,
        "systemRolePolicy": system_role_policy,
        "activeWorldbookEntries": active_worldbook_entries,
        "mergedRegexScripts": merged_regex_scripts,
        "variables": {"local": variable_context["local"], "global": variable_context["global"]},
        "stages": {
            "tagged": tagged_stages,
            "internal": internal_stages,
            "output": output_stages,
            "perItem": per_item,
        },
    }


def build_prompt_from_silly_tavern(params: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    """
    构建 Prompt（旧酒馆 SillyTavern 原始格式入口），对齐 TS buildPromptFromSillyTavern：
    先转换为新格式，再执行 build_prompt。

    支持两种调用形态：
    - build_prompt_from_silly_tavern({...}) 单 dict（camelCase 键）
    - build_prompt_from_silly_tavern(preset=..., output_format=..., ...) 关键字（snake_case）
    """
    p: dict[str, Any] = dict(params or {})
    p.update(kwargs)

    preset = p.get("preset")
    character = p.get("character")
    globals_: dict[str, Any] = p.get("globals") or {}
    history = p.get("history") or []

    converted_preset = convert_preset_from_silly_tavern(preset)
    converted_character = convert_character_from_silly_tavern(character) if character else None
    converted_history = convert_history_from_silly_tavern(history)

    converted_globals: dict[str, Any] = {}
    if globals_.get("worldBooks"):
        converted_globals["worldBooks"] = convert_worldbooks_from_silly_tavern(globals_.get("worldBooks"))
    if globals_.get("regexScripts"):
        converted_globals["regexScripts"] = convert_regexes_from_silly_tavern(globals_.get("regexScripts"))

    # 其余参数（view/output_format/outputFormat/macros/variables/options...）原样透传
    rest: dict[str, Any] = {k: v for k, v in p.items() if k not in ("preset", "character", "globals", "history")}

    return build_prompt(
        {
            "preset": converted_preset,
            **({"character": converted_character} if converted_character else {}),
            **({"globals": converted_globals} if converted_globals else {}),
            "history": converted_history,
            **rest,
        }
    )
