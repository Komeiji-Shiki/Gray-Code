from __future__ import annotations

import copy
import math
import random
from typing import Any

from ...types import (
    ChatMessage,
    CharacterCard,
    PresetInfo,
    PromptInfo,
    RegexScriptData,
    UtilityPrompts,
    WorldBook,
    WorldBookEntry,
)
from .normalize_regexes import normalize_regexes


def _is_object(v: Any) -> bool:
    return isinstance(v, dict)


def _to_array(v: Any) -> list[Any]:
    return v if isinstance(v, list) else []


def _to_str(v: Any, fallback: str = "") -> str:
    if v is None:
        return fallback
    return str(v)


def _to_num(v: Any, fallback: float) -> float:
    if isinstance(v, bool):
        return fallback
    try:
        n = float(v)
    except Exception:
        return fallback
    if not math.isfinite(n):
        return fallback
    return n


def _to_bool(v: Any, fallback: bool) -> bool:
    return v if isinstance(v, bool) else fallback


def _clone_json(v: Any) -> Any:
    try:
        return copy.deepcopy(v)
    except Exception:
        return v


def _read_string(v: Any) -> str | None:
    if v is None:
        return None
    return v if isinstance(v, str) else str(v)


def _read_number(v: Any) -> int | float | None:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and math.isfinite(float(v)):
        n = float(v)
        return int(n) if n.is_integer() else n
    try:
        n = float(v)
    except Exception:
        return None
    if not math.isfinite(n):
        return None
    return int(n) if n.is_integer() else n


def _merge_utility_prompts(base: UtilityPrompts, patch: UtilityPrompts) -> UtilityPrompts:
    return {
        "impersonationPrompt": patch.get("impersonationPrompt") if patch.get("impersonationPrompt") is not None else base.get("impersonationPrompt"),
        "worldInfoFormat": patch.get("worldInfoFormat") if patch.get("worldInfoFormat") is not None else base.get("worldInfoFormat"),
        "scenarioFormat": patch.get("scenarioFormat") if patch.get("scenarioFormat") is not None else base.get("scenarioFormat"),
        "personalityFormat": patch.get("personalityFormat") if patch.get("personalityFormat") is not None else base.get("personalityFormat"),
        "groupNudgePrompt": patch.get("groupNudgePrompt") if patch.get("groupNudgePrompt") is not None else base.get("groupNudgePrompt"),
        "newChatPrompt": patch.get("newChatPrompt") if patch.get("newChatPrompt") is not None else base.get("newChatPrompt"),
        "newGroupChatPrompt": patch.get("newGroupChatPrompt") if patch.get("newGroupChatPrompt") is not None else base.get("newGroupChatPrompt"),
        "newExampleChatPrompt": patch.get("newExampleChatPrompt") if patch.get("newExampleChatPrompt") is not None else base.get("newExampleChatPrompt"),
        "continueNudgePrompt": patch.get("continueNudgePrompt") if patch.get("continueNudgePrompt") is not None else base.get("continueNudgePrompt"),
        "sendIfEmpty": patch.get("sendIfEmpty") if patch.get("sendIfEmpty") is not None else base.get("sendIfEmpty"),
        "seed": patch.get("seed") if patch.get("seed") is not None else base.get("seed"),
    }


UTILITY_PROMPT_KEYS = [
    # snake_case (ST)
    "impersonation_prompt",
    "wi_format",
    "scenario_format",
    "personality_format",
    "group_nudge_prompt",
    "new_chat_prompt",
    "new_group_chat_prompt",
    "new_example_chat_prompt",
    "continue_nudge_prompt",
    "send_if_empty",
    "seed",
    # camelCase aliases
    "impersonationPrompt",
    "wiFormat",
    "worldInfoFormat",
    "scenarioFormat",
    "personalityFormat",
    "groupNudgePrompt",
    "newChatPrompt",
    "newGroupChatPrompt",
    "newExampleChatPrompt",
    "continueNudgePrompt",
    "sendIfEmpty",
]


def _extract_utility_prompts(other: Any) -> UtilityPrompts:
    source = other if _is_object(other) else {}

    def pick(keys: list[str]) -> Any:
        for k in keys:
            if k in source and source.get(k) is not None:
                return source.get(k)
        return None

    return {
        "impersonationPrompt": _read_string(pick(["impersonation_prompt", "impersonationPrompt"])),
        "worldInfoFormat": _read_string(pick(["wi_format", "wiFormat", "worldInfoFormat"])),
        "scenarioFormat": _read_string(pick(["scenario_format", "scenarioFormat"])),
        "personalityFormat": _read_string(pick(["personality_format", "personalityFormat"])),
        "groupNudgePrompt": _read_string(pick(["group_nudge_prompt", "groupNudgePrompt"])),
        "newChatPrompt": _read_string(pick(["new_chat_prompt", "newChatPrompt"])),
        "newGroupChatPrompt": _read_string(pick(["new_group_chat_prompt", "newGroupChatPrompt"])),
        "newExampleChatPrompt": _read_string(pick(["new_example_chat_prompt", "newExampleChatPrompt"])),
        "continueNudgePrompt": _read_string(pick(["continue_nudge_prompt", "continueNudgePrompt"])),
        "sendIfEmpty": _read_string(pick(["send_if_empty", "sendIfEmpty"])),
        "seed": _read_number(pick(["seed"])),
    }


def _strip_utility_prompts(other: dict[str, Any]) -> None:
    for key in UTILITY_PROMPT_KEYS:
        if key in other:
            del other[key]


def _normalize_utility_prompts(input_value: Any) -> UtilityPrompts:
    if not _is_object(input_value):
        return {}
    return {
        "impersonationPrompt": _read_string(input_value.get("impersonationPrompt")),
        "worldInfoFormat": _read_string(input_value.get("worldInfoFormat")),
        "scenarioFormat": _read_string(input_value.get("scenarioFormat")),
        "personalityFormat": _read_string(input_value.get("personalityFormat")),
        "groupNudgePrompt": _read_string(input_value.get("groupNudgePrompt")),
        "newChatPrompt": _read_string(input_value.get("newChatPrompt")),
        "newGroupChatPrompt": _read_string(input_value.get("newGroupChatPrompt")),
        "newExampleChatPrompt": _read_string(input_value.get("newExampleChatPrompt")),
        "continueNudgePrompt": _read_string(input_value.get("continueNudgePrompt")),
        "sendIfEmpty": _read_string(input_value.get("sendIfEmpty")),
        "seed": _read_number(input_value.get("seed")),
    }


REGEX_TARGET_MAP_FROM_ST: dict[int, str] = {
    1: "userInput",
    2: "aiOutput",
    3: "slashCommands",
    5: "worldBook",
    6: "reasoning",
}

REGEX_LEGACY_TARGET_MAP: dict[str, str] = {
    "userInput": "userInput",
    "aiOutput": "aiOutput",
    "slashCommands": "slashCommands",
    "worldBook": "worldBook",
    "reasoning": "reasoning",
    "user": "userInput",
    "model": "aiOutput",
    "assistant_response": "aiOutput",
    "preset": "slashCommands",
    "world_book": "worldBook",
}

REGEX_MACRO_MODE_MAP: dict[int, str] = {
    0: "none",
    1: "raw",
    2: "escaped",
}


def _dedupe_keep_order(items: list[str]) -> list[str]:
    out: list[str] = []
    for item in items:
        if item not in out:
            out.append(item)
    return out


def _normalize_regex_target(v: Any) -> str | None:
    if isinstance(v, int):
        return REGEX_TARGET_MAP_FROM_ST.get(v)
    s = _to_str(v).strip()
    if not s:
        return None
    return REGEX_LEGACY_TARGET_MAP.get(s)


def _normalize_regex_view(v: Any) -> str | None:
    s = _to_str(v).strip()
    if s in ("user", "model"):
        return s
    if s == "user_view":
        return "user"
    if s in ("model_view", "assistant_view"):
        return "model"
    return None


def _normalize_regex_macro_mode(v: Any) -> str:
    if v in ("none", "raw", "escaped"):
        return str(v)
    if isinstance(v, int):
        return REGEX_MACRO_MODE_MAP.get(v, "none")
    return "none"


def _normalize_depth(v: Any) -> int | float | None:
    if v is None:
        return None
    return _read_number(v)


# 单条旧酒馆正则 -> 新格式 RegexScriptData

def convert_regex_from_silly_tavern(raw_regex: Any) -> RegexScriptData:
    raw = raw_regex if _is_object(raw_regex) else {}

    name = _to_str(raw.get("name") if raw.get("name") is not None else raw.get("scriptName"), "")
    fallback_id_base = name or "regex"
    script_id = _to_str(raw.get("id"), "").strip() or f"{fallback_id_base}_{random.randint(0, 36**8 - 1):08x}"

    targets_from_targets = [t for t in (_normalize_regex_target(x) for x in _to_array(raw.get("targets"))) if t]
    placement_raw = raw.get("placement")
    if isinstance(placement_raw, list):
        placements = placement_raw
    elif placement_raw is None:
        placements = []
    else:
        placements = [placement_raw]
    targets_from_placement = [t for t in (_normalize_regex_target(x) for x in placements) if t]
    targets = _dedupe_keep_order(targets_from_targets if len(targets_from_targets) > 0 else targets_from_placement)

    view_from_view = [x for x in (_normalize_regex_view(v) for v in _to_array(raw.get("view"))) if x]
    view = (
        view_from_view
        if len(view_from_view) > 0
        else [
            *(["user"] if raw.get("markdownOnly") else []),
            *(["model"] if raw.get("promptOnly") else []),
        ]
    )

    if isinstance(raw.get("enabled"), bool):
        enabled = bool(raw.get("enabled"))
    elif isinstance(raw.get("disabled"), bool):
        enabled = not bool(raw.get("disabled"))
    else:
        enabled = True

    trim_source = raw.get("trimRegex") if raw.get("trimRegex") is not None else raw.get("trimStrings")

    return {
        "id": script_id,
        "name": name,
        "enabled": enabled,
        "findRegex": _to_str(raw.get("findRegex"), ""),
        "replaceRegex": _to_str(raw.get("replaceRegex") if raw.get("replaceRegex") is not None else raw.get("replaceString"), ""),
        "trimRegex": [_to_str(x) for x in _to_array(trim_source)],
        "targets": targets,  # type: ignore[typeddict-item]
        "view": view,  # type: ignore[typeddict-item]
        "runOnEdit": _to_bool(raw.get("runOnEdit"), False),
        "macroMode": _normalize_regex_macro_mode(raw.get("macroMode") if raw.get("macroMode") is not None else raw.get("substituteRegex")),  # type: ignore[typeddict-item]
        "minDepth": _normalize_depth(raw.get("minDepth")),
        "maxDepth": _normalize_depth(raw.get("maxDepth")),
    }


def _collect_regex_items(input_value: Any, out: list[Any]) -> None:
    if input_value is None:
        return
    if isinstance(input_value, list):
        for item in input_value:
            _collect_regex_items(item, out)
        return
    if _is_object(input_value) and isinstance(input_value.get("regexScripts"), list):
        _collect_regex_items(input_value.get("regexScripts"), out)
        return
    if _is_object(input_value) and isinstance(input_value.get("scripts"), list):
        _collect_regex_items(input_value.get("scripts"), out)
        return
    out.append(input_value)


# 旧酒馆正则集合（多形态）-> 新格式 RegexScriptData[]
def convert_regexes_from_silly_tavern(input_value: Any) -> list[RegexScriptData]:
    if input_value is None:
        return []
    raw_items: list[Any] = []
    _collect_regex_items(input_value, raw_items)
    return normalize_regexes([convert_regex_from_silly_tavern(x) for x in raw_items])


WORLDBOOK_POSITION_MAP_FROM_ST: dict[int, str] = {
    0: "beforeChar",
    1: "afterChar",
    2: "beforeAn",
    3: "afterAn",
    4: "fixed",
    5: "beforeEm",
    6: "afterEm",
    7: "outlet",
}

WORLDBOOK_POSITION_MAP_FROM_STR: dict[str, str] = {
    "beforeChar": "beforeChar",
    "afterChar": "afterChar",
    "beforeAn": "beforeAn",
    "afterAn": "afterAn",
    "fixed": "fixed",
    "beforeEm": "beforeEm",
    "afterEm": "afterEm",
    "outlet": "outlet",
    "before_char": "beforeChar",
    "after_char": "afterChar",
    "before_an": "beforeAn",
    "after_an": "afterAn",
    "before_em": "beforeEm",
    "after_em": "afterEm",
}

WORLDBOOK_ROLE_MAP_FROM_ST: dict[int, str] = {
    0: "system",
    1: "user",
    2: "model",
}

WORLDBOOK_SELECTIVE_LOGIC_MAP_FROM_ST: dict[int, str] = {
    0: "andAny",
    1: "notAll",
    2: "notAny",
    3: "andAll",
}


def _normalize_worldbook_position(position: Any, ext_position: Any) -> str:
    p = position if position is not None else ext_position
    if isinstance(p, int):
        return WORLDBOOK_POSITION_MAP_FROM_ST.get(p, str(p))

    s = _to_str(p).strip()
    if not s:
        return "beforeChar"

    try:
        maybe_numeric = float(s)
        if math.isfinite(maybe_numeric) and maybe_numeric.is_integer():
            return WORLDBOOK_POSITION_MAP_FROM_ST.get(int(maybe_numeric), s)
    except Exception:
        pass

    return WORLDBOOK_POSITION_MAP_FROM_STR.get(s, s)


def _normalize_worldbook_selective_logic(v: Any) -> str:
    if v in ("andAny", "andAll", "notAll", "notAny"):
        return str(v)
    if isinstance(v, int):
        return WORLDBOOK_SELECTIVE_LOGIC_MAP_FROM_ST.get(v, "andAny")
    return "andAny"


def _normalize_worldbook_role(v: Any) -> str:
    if v in ("system", "user", "model"):
        return str(v)
    if isinstance(v, int):
        return WORLDBOOK_ROLE_MAP_FROM_ST.get(v, "system")
    return "system"


def _normalize_worldbook_activation_mode(raw: dict[str, Any], ext: dict[str, Any]) -> str:
    if raw.get("activationMode") in ("always", "keyword", "vector"):
        return str(raw.get("activationMode"))
    constant = raw.get("constant") if raw.get("constant") is not None else ext.get("constant")
    vectorized = raw.get("vectorized") if raw.get("vectorized") is not None else ext.get("vectorized")
    if constant:
        return "always"
    if vectorized:
        return "vector"
    return "keyword"


# 单条旧酒馆世界书条目 -> 新格式 WorldBookEntry
def convert_worldbook_entry_from_silly_tavern(raw_entry: Any, fallback_index: int = 0) -> WorldBookEntry | None:
    if not _is_object(raw_entry):
        return None

    ext = raw_entry.get("extensions") if _is_object(raw_entry.get("extensions")) else {}

    index = int(_to_num(raw_entry.get("index", raw_entry.get("uid", raw_entry.get("id", fallback_index))), fallback_index))
    position = _normalize_worldbook_position(raw_entry.get("position"), ext.get("position"))

    selective_logic = _normalize_worldbook_selective_logic(
        raw_entry.get("selectiveLogic") if raw_entry.get("selectiveLogic") is not None else ext.get("selectiveLogic", ext.get("selective_logic"))
    )

    role = _normalize_worldbook_role(raw_entry.get("role") if raw_entry.get("role") is not None else ext.get("role")) if position == "fixed" else None

    case_sensitive_raw = (
        raw_entry.get("caseSensitive")
        if raw_entry.get("caseSensitive") is not None
        else ext.get("caseSensitive", ext.get("case_sensitive"))
    )
    case_sensitive = case_sensitive_raw if (case_sensitive_raw is None or isinstance(case_sensitive_raw, bool)) else None

    raw_other = raw_entry.get("other") if _is_object(raw_entry.get("other")) else {}
    stripped_keys = {
        "index",
        "uid",
        "id",
        "name",
        "comment",
        "content",
        "enabled",
        "disable",
        "activationMode",
        "constant",
        "vectorized",
        "key",
        "keys",
        "secondaryKey",
        "keysecondary",
        "secondary_keys",
        "selectiveLogic",
        "insertion_order",
        "order",
        "depth",
        "position",
        "role",
        "caseSensitive",
        "excludeRecursion",
        "preventRecursion",
        "probability",
        "extensions",
        "other",
    }
    rest_raw = {k: v for k, v in raw_entry.items() if k not in stripped_keys}

    other: dict[str, Any] = {**raw_other, **rest_raw}
    if len(ext.keys()) > 0 and "extensions" not in other:
        other["extensions"] = ext

    depth_source = raw_entry.get("depth") if raw_entry.get("depth") is not None else ext.get("depth")

    return {
        "index": index,
        "name": _to_str(raw_entry.get("name") if raw_entry.get("name") is not None else raw_entry.get("comment"), ""),
        "content": _to_str(raw_entry.get("content"), ""),
        "enabled": (
            bool(raw_entry.get("enabled"))
            if isinstance(raw_entry.get("enabled"), bool)
            else (not bool(raw_entry.get("disable")) if isinstance(raw_entry.get("disable"), bool) else True)
        ),
        "activationMode": _normalize_worldbook_activation_mode(raw_entry, ext),  # type: ignore[typeddict-item]
        "key": [_to_str(x) for x in _to_array(raw_entry.get("key") if raw_entry.get("key") is not None else raw_entry.get("keys"))],
        "secondaryKey": [_to_str(x) for x in _to_array(
            raw_entry.get("secondaryKey") if raw_entry.get("secondaryKey") is not None else raw_entry.get("keysecondary") if raw_entry.get("keysecondary") is not None else raw_entry.get("secondary_keys")
        )],
        "selectiveLogic": selective_logic,  # type: ignore[typeddict-item]
        "order": int(_to_num(raw_entry.get("order") if raw_entry.get("order") is not None else raw_entry.get("insertion_order"), 100)),
        "depth": int(_to_num(depth_source, 4)),
        "position": position,
        "role": role,  # type: ignore[typeddict-item]
        "caseSensitive": case_sensitive,
        "excludeRecursion": _to_bool(
            raw_entry.get("excludeRecursion") if raw_entry.get("excludeRecursion") is not None else ext.get("excludeRecursion", ext.get("exclude_recursion")),
            False,
        ),
        "preventRecursion": _to_bool(
            raw_entry.get("preventRecursion") if raw_entry.get("preventRecursion") is not None else ext.get("preventRecursion", ext.get("prevent_recursion")),
            False,
        ),
        "probability": int(_to_num(raw_entry.get("probability") if raw_entry.get("probability") is not None else ext.get("probability"), 100)),
        "other": other,
    }


# 单本旧酒馆世界书 -> 新格式 WorldBook
def convert_worldbook_from_silly_tavern(raw_book: Any, options: dict[str, Any] | None = None) -> WorldBook:
    book = raw_book
    opts = options or {}

    own_name = _to_str(book.get("name"), "").strip() if _is_object(book) else ""
    fallback_name = _to_str(opts.get("name"), "").strip()
    name = own_name or fallback_name or "WorldBook"

    entries: list[WorldBookEntry] = []

    if isinstance(book, list):
        for idx, raw in enumerate(book):
            converted = convert_worldbook_entry_from_silly_tavern(raw, idx)
            if converted:
                entries.append(converted)
    elif _is_object(book) and isinstance(book.get("entries"), list):
        for idx, raw in enumerate(book.get("entries") or []):
            converted = convert_worldbook_entry_from_silly_tavern(raw, idx)
            if converted:
                entries.append(converted)
    elif _is_object(book) and _is_object(book.get("entries")):
        entries_obj = book.get("entries") or {}
        for idx, (k, raw) in enumerate(entries_obj.items()):
            try:
                fallback_index = int(k)
            except Exception:
                fallback_index = idx
            converted = convert_worldbook_entry_from_silly_tavern(raw, fallback_index)
            if converted:
                entries.append(converted)
    elif _is_object(book):
        converted = convert_worldbook_entry_from_silly_tavern(book, 0)
        if converted:
            entries.append(converted)

    return {"name": name, "entries": entries}


# 旧酒馆世界书集合（多形态）-> 新格式 WorldBook[]
def convert_worldbooks_from_silly_tavern(input_value: Any) -> list[WorldBook]:
    if input_value is None:
        return []

    if isinstance(input_value, list):
        all_entry_like = all(_is_object(x) and ("content" in x or "comment" in x) for x in input_value)
        if all_entry_like:
            return [convert_worldbook_from_silly_tavern(input_value, {"name": "WorldBook"})]

        out: list[WorldBook] = []
        for idx, item in enumerate(input_value):
            if item is None:
                continue
            out.append(convert_worldbook_from_silly_tavern(item, {"name": f"WorldBook_{idx + 1}"}))
        return out

    return [convert_worldbook_from_silly_tavern(input_value, {"name": "WorldBook"})]


def _get_prompt_order_list(raw_order: Any) -> list[dict[str, Any]]:
    if isinstance(raw_order, list):
        # 取最后一个有效条目（character_id: 100001 是实际使用的排序，排在 100000 之后）
        candidates = [x for x in raw_order if _is_object(x) and isinstance(x.get("order"), list)]
        last = candidates[-1] if candidates else None
        if not last:
            return []
        return [
            {"identifier": _to_str(x.get("identifier")), "enabled": _to_bool(x.get("enabled"), True)}
            for x in _to_array(last.get("order"))
            if _is_object(x) and isinstance(x.get("identifier"), str)
        ]

    if _is_object(raw_order) and isinstance(raw_order.get("order"), list):
        return [
            {"identifier": _to_str(x.get("identifier")), "enabled": _to_bool(x.get("enabled"), True)}
            for x in _to_array(raw_order.get("order"))
            if _is_object(x) and isinstance(x.get("identifier"), str)
        ]

    return []


def _convert_prompt_from_silly_tavern(
    raw_prompt: Any,
    order_map: dict[str, dict[str, Any]],
    fallback_index: int,
) -> PromptInfo | None:
    if not _is_object(raw_prompt):
        return None

    # 酒馆标准 marker identifier → 新格式 identifier
    ST_IDENTIFIER_MAP: dict[str, str] = {
        "worldInfoBefore": "charBefore",
        "worldInfoAfter":  "charAfter",
    }

    injection_depth = raw_prompt.get("injection_depth")
    injection_order = raw_prompt.get("injection_order")
    injection_trigger = raw_prompt.get("injection_trigger")
    injection_position = raw_prompt.get("injection_position")
    system_prompt = raw_prompt.get("system_prompt")

    rest = dict(raw_prompt)
    for k in ("injection_depth", "injection_order", "injection_trigger", "injection_position", "system_prompt"):
        rest.pop(k, None)

    raw_identifier = _to_str(rest.get("identifier", f"prompt_{fallback_index}"), "").strip() or f"prompt_{fallback_index}"
    identifier = ST_IDENTIFIER_MAP.get(raw_identifier, raw_identifier)
    # prompt_order 中使用的仍然是酒馆原始 identifier
    order_item = order_map.get(raw_identifier) or order_map.get(identifier)

    if rest.get("position") in ("relative", "fixed"):
        position = rest.get("position")
    else:
        position = "fixed" if int(_to_num(injection_position, 0)) == 1 else "relative"

    role = _to_str(rest.get("role", "system" if system_prompt else "system"))

    out: PromptInfo = {
        **rest,
        "identifier": identifier,
        "name": _to_str(rest.get("name", identifier)),
        "enabled": bool(order_item.get("enabled")) if order_item else (False if len(order_map) > 0 else _to_bool(rest.get("enabled"), True)),
        "role": role,
        "content": _to_str(rest.get("content"), ""),
        "depth": int(_to_num(injection_depth if injection_depth is not None else rest.get("depth"), 0)),
        "order": int(_to_num(injection_order if injection_order is not None else rest.get("order"), 100)),
        "trigger": (injection_trigger if isinstance(injection_trigger, list) else rest.get("trigger") if isinstance(rest.get("trigger"), list) else []),
        "position": position,  # type: ignore[typeddict-item]
    }

    if order_item:
        out["index"] = int(order_item.get("index"))
    elif isinstance(rest.get("index"), (int, float)):
        out["index"] = int(rest.get("index"))

    return out


# 旧酒馆 preset/settings -> 新格式 PresetInfo

def convert_preset_from_silly_tavern(raw_preset: Any, options: dict[str, Any] | None = None) -> PresetInfo:
    raw = raw_preset if _is_object(raw_preset) else {}
    opts = options or {}

    # 1) other 源：new.other > old.apiSetting > 旧平铺 settings
    if _is_object(raw.get("other")):
        other_source: dict[str, Any] = _clone_json(raw.get("other"))
    elif _is_object(raw.get("apiSetting")):
        other_source = _clone_json(raw.get("apiSetting"))
    else:
        rest = dict(raw)
        for k in ("name", "prompts", "prompt_order", "regexScripts", "utilityPrompts", "other", "apiSetting"):
            rest.pop(k, None)
        other_source = _clone_json(rest)

    other_source.pop("prompts", None)
    other_source.pop("prompt_order", None)

    # 2) utilityPrompts：other 提取 + 显式 utilityPrompts 覆盖
    utility_from_other = _extract_utility_prompts(other_source)
    _strip_utility_prompts(other_source)
    utility_prompts = _merge_utility_prompts(utility_from_other, _normalize_utility_prompts(raw.get("utilityPrompts")))

    # 3) regexScripts：显式 regexScripts 优先，否则从 other.extensions.regex_scripts 读取
    has_explicit_regex_scripts = "regexScripts" in raw
    if has_explicit_regex_scripts:
        regex_scripts = convert_regexes_from_silly_tavern(raw.get("regexScripts"))
    else:
        ext = other_source.get("extensions") if _is_object(other_source.get("extensions")) else {}
        regex_scripts = convert_regexes_from_silly_tavern(ext.get("regex_scripts") if ext.get("regex_scripts") is not None else ext.get("regexScripts", []))

    # 4) prompts + prompt_order 合并
    prompt_list = _to_array(raw.get("prompts"))
    api_setting = raw.get("apiSetting") if _is_object(raw.get("apiSetting")) else {}
    raw_other_for_order = raw.get("other") if _is_object(raw.get("other")) else {}
    order_list = _get_prompt_order_list(
        raw.get("prompt_order")
        if raw.get("prompt_order") is not None
        else api_setting.get("prompt_order")
        if api_setting.get("prompt_order") is not None
        else raw_other_for_order.get("prompt_order")
    )

    order_map: dict[str, dict[str, Any]] = {}
    for idx, item in enumerate(order_list):
        order_map[str(item.get("identifier"))] = {"enabled": bool(item.get("enabled")), "index": idx}

    prompt_pairs: list[tuple[PromptInfo, int]] = []
    for idx, p in enumerate(prompt_list):
        converted = _convert_prompt_from_silly_tavern(p, order_map, idx)
        if converted:
            prompt_pairs.append((converted, idx))

    def sort_key(pair: tuple[PromptInfo, int]) -> tuple[float, int]:
        p, idx = pair
        index_value = p.get("index")
        if isinstance(index_value, (int, float)):
            return (float(index_value), idx)
        return (float("inf"), idx)

    prompt_pairs.sort(key=sort_key)
    prompts = [p for p, _ in prompt_pairs]

    return {
        "name": _to_str(opts.get("name") if opts.get("name") is not None else raw.get("name"), "Default") or "Default",
        "prompts": prompts,
        "utilityPrompts": utility_prompts,
        "regexScripts": regex_scripts,
        "other": other_source,
    }


# 旧酒馆角色卡 -> 新格式 CharacterCard

def convert_character_from_silly_tavern(raw_character: Any) -> CharacterCard:
    raw = raw_character if _is_object(raw_character) else {}
    data = raw.get("data") if _is_object(raw.get("data")) else {}

    name = _to_str(data.get("name") if data.get("name") is not None else raw.get("name"), "")
    description = _to_str(data.get("description") if data.get("description") is not None else raw.get("description"), "")
    avatar = _to_str(
        raw.get("avatar")
        if raw.get("avatar") is not None
        else raw.get("avatar_url")
        if raw.get("avatar_url") is not None
        else data.get("avatar"),
        "",
    )

    if isinstance(raw.get("message"), list):
        message = [_to_str(x) for x in raw.get("message") or []]
    else:
        first_mes = data.get("first_mes") if data.get("first_mes") is not None else raw.get("first_mes")
        alternates = [_to_str(x) for x in _to_array(data.get("alternate_greetings") if data.get("alternate_greetings") is not None else raw.get("alternate_greetings"))]
        if first_mes is None and len(alternates) == 0:
            message = []
        else:
            message = [_to_str(first_mes, ""), *alternates]

    if "worldBook" in raw and raw.get("worldBook") is None:
        world_book = None
    elif _is_object(raw.get("worldBook")) or isinstance(raw.get("worldBook"), list):
        wb = raw.get("worldBook")
        wb_name = _to_str(wb.get("name") if _is_object(wb) and wb.get("name") is not None else name)
        world_book = convert_worldbook_from_silly_tavern(wb, {"name": wb_name or name})
    elif _is_object(data.get("character_book")):
        wb = data.get("character_book")
        wb_name = _to_str(wb.get("name") if _is_object(wb) and wb.get("name") is not None else name)
        world_book = convert_worldbook_from_silly_tavern(wb, {"name": wb_name or name})
    else:
        world_book = None

    has_explicit_regex_scripts = "regexScripts" in raw
    if has_explicit_regex_scripts:
        regex_scripts = convert_regexes_from_silly_tavern(raw.get("regexScripts"))
    else:
        ext = data.get("extensions") if _is_object(data.get("extensions")) else {}
        regex_scripts = convert_regexes_from_silly_tavern(
            ext.get("regex_scripts") if ext.get("regex_scripts") is not None else ext.get("regexScripts", [])
        )

    if _is_object(raw.get("other")):
        other = _clone_json(raw.get("other"))
    else:
        copy_raw = _clone_json(raw)
        if _is_object(copy_raw.get("data", {}).get("extensions")):
            copy_raw["data"]["extensions"].pop("regex_scripts", None)
            copy_raw["data"]["extensions"].pop("regexScripts", None)
        if _is_object(copy_raw.get("data")):
            copy_raw["data"].pop("character_book", None)
            copy_raw["data"].pop("first_mes", None)
            copy_raw["data"].pop("alternate_greetings", None)
        copy_raw.pop("first_mes", None)
        copy_raw.pop("alternate_greetings", None)
        copy_raw.pop("chat", None)
        copy_raw.pop("create_date", None)
        other = copy_raw

    return {
        "name": name,
        "description": description,
        "avatar": avatar,
        "message": message,
        "worldBook": world_book,
        "regexScripts": regex_scripts,
        "other": other,
        "chatDate": _to_str(raw.get("chatDate") if raw.get("chatDate") is not None else raw.get("chat"), ""),
        "createDate": _to_str(raw.get("createDate") if raw.get("createDate") is not None else raw.get("create_date"), ""),
    }


def _normalize_history_role(raw_message: dict[str, Any]) -> str:
    role = _to_str(raw_message.get("role"), "").lower()
    if role in ("assistant", "model"):
        return "model"
    if role in ("user", "system"):
        return role
    if raw_message.get("is_user"):
        return "user"
    if raw_message.get("is_system"):
        return "system"
    return "model"


# 单条旧酒馆聊天消息 -> 新格式 ChatMessage

def convert_history_message_from_silly_tavern(raw_message: Any) -> ChatMessage | None:
    if not _is_object(raw_message):
        return None

    role = _normalize_history_role(raw_message)
    name = _read_string(raw_message.get("name"))
    swipe_id = _read_number(raw_message.get("swipeId") if raw_message.get("swipeId") is not None else raw_message.get("swipe_id"))

    if isinstance(raw_message.get("parts"), list):
        part_swipes = (
            _clone_json(raw_message.get("swipes"))
            if isinstance(raw_message.get("swipes"), list) and all(isinstance(s, list) for s in raw_message.get("swipes") or [])
            else None
        )
        return {
            "role": role,
            **({"name": name} if name else {}),
            **({"swipeId": int(swipe_id)} if isinstance(swipe_id, (int, float)) else {}),
            "parts": _clone_json(raw_message.get("parts")),
            **({"swipes": part_swipes} if part_swipes is not None else {}),
        }

    content = _to_str(raw_message.get("content") if raw_message.get("content") is not None else raw_message.get("mes"), "")
    swipes = [_to_str(x) for x in raw_message.get("swipes")] if isinstance(raw_message.get("swipes"), list) else None

    return {
        "role": role,
        **({"name": name} if name else {}),
        **({"swipeId": int(swipe_id)} if isinstance(swipe_id, (int, float)) else {}),
        "content": content,
        **({"swipes": swipes} if swipes is not None else {}),
    }


# 旧酒馆聊天数组 -> 新格式 ChatMessage[]
def convert_history_from_silly_tavern(raw_messages: Any) -> list[ChatMessage]:
    if not isinstance(raw_messages, list):
        return []
    out: list[ChatMessage] = []
    for msg in raw_messages:
        converted = convert_history_message_from_silly_tavern(msg)
        if converted:
            out.append(converted)
    return out


# TS-style aliases
convertPresetFromSillyTavern = convert_preset_from_silly_tavern
convertWorldBookEntryFromSillyTavern = convert_worldbook_entry_from_silly_tavern
convertWorldBookFromSillyTavern = convert_worldbook_from_silly_tavern
convertWorldBooksFromSillyTavern = convert_worldbooks_from_silly_tavern
convertRegexFromSillyTavern = convert_regex_from_silly_tavern
convertRegexesFromSillyTavern = convert_regexes_from_silly_tavern
convertCharacterFromSillyTavern = convert_character_from_silly_tavern
convertHistoryMessageFromSillyTavern = convert_history_message_from_silly_tavern
convertHistoryFromSillyTavern = convert_history_from_silly_tavern


__all__ = [
    "convert_preset_from_silly_tavern",
    "convert_worldbook_entry_from_silly_tavern",
    "convert_worldbook_from_silly_tavern",
    "convert_worldbooks_from_silly_tavern",
    "convert_regex_from_silly_tavern",
    "convert_regexes_from_silly_tavern",
    "convert_character_from_silly_tavern",
    "convert_history_message_from_silly_tavern",
    "convert_history_from_silly_tavern",
    "convertPresetFromSillyTavern",
    "convertWorldBookEntryFromSillyTavern",
    "convertWorldBookFromSillyTavern",
    "convertWorldBooksFromSillyTavern",
    "convertRegexFromSillyTavern",
    "convertRegexesFromSillyTavern",
    "convertCharacterFromSillyTavern",
    "convertHistoryMessageFromSillyTavern",
    "convertHistoryFromSillyTavern",
]
