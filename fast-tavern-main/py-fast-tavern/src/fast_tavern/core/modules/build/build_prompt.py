from __future__ import annotations

from typing import Any, cast

from ...convert import convert_messages_out
from ...types import BuildPromptResult, ChatMessage, RegexView, Role, TaggedContent
from ..assemble import assemble_tagged_prompt_list
from ..inputs import normalize_regexes, normalize_worldbooks
from ..pipeline import compile_tagged_stages
from ..regex import merge_regex_rules
from ..variables import create_variable_context
from ..worldbook import get_active_entries


def _normalize_role(raw: Any, fallback: Role = "user") -> Role:
    r = str(raw or "").lower()
    if r == "system":
        return "system"
    if r == "user":
        return "user"
    if r in ("model", "assistant"):
        return "model"
    return fallback


def _chat_message_to_text(m: ChatMessage) -> str:
    if not m:
        return ""
    if isinstance(m, dict) and "content" in m:
        return str(m.get("content") or "")
    parts = (m or {}).get("parts") or []
    return "".join((p.get("text") or "") for p in parts if isinstance(p, dict) and "text" in p)


def _to_internal_history(messages: list[ChatMessage]) -> list[ChatMessage]:
    out: list[ChatMessage] = []
    for m in messages or []:
        role = _normalize_role(m.get("role"), "user")
        if isinstance(m, dict) and "parts" in m:
            out.append(
                {
                    "role": role,
                    **({"name": m["name"]} if m.get("name") else {}),
                    **({"swipeId": m["swipeId"]} if isinstance(m.get("swipeId"), int) else {}),
                    "parts": [dict(p) for p in (m.get("parts") or [])],
                    **({"swipes": m["swipes"]} if isinstance(m.get("swipes"), list) else {}),
                }
            )
        else:
            out.append(
                {
                    "role": role,
                    **({"name": m["name"]} if m.get("name") else {}),
                    **({"swipeId": m["swipeId"]} if isinstance(m.get("swipeId"), int) else {}),
                    "parts": [{"text": str((m or {}).get("content") or "")}],
                }
            )
    return out


def _internal_history_to_chat_nodes(internal: list[ChatMessage]) -> list[dict[str, Any]]:
    lst = [{"role": _normalize_role(m.get("role"), "user"), "text": _chat_message_to_text(m)} for m in (internal or [])]
    n = len(lst)
    return [{**x, "historyDepth": n - 1 - idx} for idx, x in enumerate(lst)]


def _tagged_to_internal(tagged: list[TaggedContent]) -> list[ChatMessage]:
    return [{"role": item.get("role"), "parts": [{"text": item.get("text") or ""}]} for item in (tagged or [])]


def _apply_system_role_policy(internal: list[ChatMessage], policy: str) -> list[ChatMessage]:
    if policy == "keep":
        return internal
    return [
        {**m, "role": ("user" if str(m.get("role") or "") == "system" else m.get("role"))}
        for m in (internal or [])
    ]


def _build_macros(user_macros: dict[str, str], character: dict[str, Any] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if character and character.get("name"):
        out["char"] = str(character.get("name"))
    return {**out, **(user_macros or {})}


def _normalize_preset_compat(preset: dict[str, Any] | None) -> dict[str, Any]:
    """
    Backward compatibility: allow legacy preset.apiSetting input.

    Current build pipeline does not directly consume other/apiSetting,
    but we normalize here to keep input semantics aligned with TS.
    """
    raw = dict(preset or {})
    return {**raw, "other": raw.get("other", raw.get("apiSetting", {})), "utilityPrompts": raw.get("utilityPrompts", {})}


def build_prompt(params: dict[str, Any] | None = None, **kwargs: Any) -> BuildPromptResult:
    """
    Main entry (align with TS buildPrompt).

    Supports both calling styles:
    - build_prompt({...})  # TS-like single dict param
    - build_prompt(preset=..., history=..., ...)  # Python kwargs
    """
    params = {**(params or {}), **kwargs}
    preset = params.get("preset")
    character = params.get("character")
    globals_ = params.get("globals") or {}
    history = params.get("history") or []
    macros = params.get("macros") or {}
    variables = params.get("variables")
    global_variables = params.get("globalVariables")
    view: RegexView = params.get("view")
    options = params.get("options") or {}


    normalized_preset = _normalize_preset_compat(preset)
    final_macros = _build_macros(dict(macros), character)
    variable_context = create_variable_context(variables, global_variables)

    # 1) history -> internal(parts) and chat nodes with historyDepth
    internal_history = _to_internal_history(history)
    chat_nodes = _internal_history_to_chat_nodes(internal_history)

    recent_n = int(options.get("recentHistoryForWorldbook") if options.get("recentHistoryForWorldbook") is not None else 5)
    recent_text = "\n".join(n.get("text") or "" for n in chat_nodes[-recent_n:])

    # 2) worldbook: global + character
    global_worldbook_entries = normalize_worldbooks(globals_.get("worldBooks"))
    active_entries = get_active_entries(
        {
            "contextText": recent_text,
            "globalEntries": global_worldbook_entries,
            "characterWorldBook": (character or {}).get("worldBook") if character else None,
            "options": {
                "vectorSearch": options.get("vectorSearch"),
                "recursionLimit": options.get("recursionLimit"),
                "rng": options.get("rng"),
                "defaultCaseSensitive": options.get("defaultCaseSensitive"),
            },
        }
    )

    # 3) assemble tagged list
    tagged = assemble_tagged_prompt_list(
        {
            "presetPrompts": normalized_preset.get("prompts") if normalized_preset else [],
            "activeEntries": active_entries,
            "chatHistory": chat_nodes,
            "positionMap": options.get("positionMap"),
        }
    )

    # 4) regex: global + preset + character
    global_scripts = normalize_regexes(globals_.get("regexScripts"))
    preset_scripts = normalize_regexes(normalized_preset.get("regexScripts") if normalized_preset else None)
    character_scripts = normalize_regexes((character or {}).get("regexScripts") if character else None)
    scripts = merge_regex_rules({"globalScripts": global_scripts, "presetScripts": preset_scripts, "characterScripts": character_scripts})

    # 5) compile stages
    compiled = compile_tagged_stages(
        tagged,
        {"view": view, "scripts": scripts, "macros": final_macros, "variableContext": variable_context},
    )

    tagged_stages = compiled["stages"]
    per_item = compiled["perItem"]

    internal_stages = {
        "raw": _tagged_to_internal(tagged_stages["raw"]),
        "afterPreRegex": _tagged_to_internal(tagged_stages["afterPreRegex"]),
        "afterMacro": _tagged_to_internal(tagged_stages["afterMacro"]),
        "afterPostRegex": _tagged_to_internal(tagged_stages["afterPostRegex"]),
    }

    output_format = params.get("output_format") or params.get("outputFormat") or "gemini"
    system_role_policy = params.get("system_role_policy") or params.get("systemRolePolicy") or "keep"

    internal_after_policy = {
        "raw": _apply_system_role_policy(internal_stages["raw"], system_role_policy),
        "afterPreRegex": _apply_system_role_policy(internal_stages["afterPreRegex"], system_role_policy),
        "afterMacro": _apply_system_role_policy(internal_stages["afterMacro"], system_role_policy),
        "afterPostRegex": _apply_system_role_policy(internal_stages["afterPostRegex"], system_role_policy),
    }

    if output_format == "tagged":
        output_stages = tagged_stages
    else:
        output_stages = {
            "raw": convert_messages_out(internal_after_policy["raw"], cast(Any, output_format)),
            "afterPreRegex": convert_messages_out(internal_after_policy["afterPreRegex"], cast(Any, output_format)),
            "afterMacro": convert_messages_out(internal_after_policy["afterMacro"], cast(Any, output_format)),
            "afterPostRegex": convert_messages_out(internal_after_policy["afterPostRegex"], cast(Any, output_format)),
        }

    return {
        "outputFormat": output_format,
        "systemRolePolicy": system_role_policy,
        "activeWorldbookEntries": active_entries,
        "mergedRegexScripts": scripts,
        "variables": {"local": dict(variable_context["local"]), "global": dict(variable_context["global"])},
        "stages": {"tagged": tagged_stages, "internal": internal_stages, "output": output_stages, "perItem": per_item},
    }

