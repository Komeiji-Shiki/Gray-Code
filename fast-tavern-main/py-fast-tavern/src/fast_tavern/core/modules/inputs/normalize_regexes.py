from __future__ import annotations

from typing import Any

from ...types import RegexScriptData, RegexScriptsFileInput, RegexScriptsInput


def _is_regex_script_array(v: Any) -> bool:
    return isinstance(v, list) and all(
        isinstance(x, dict) and ("findRegex" in x) and ("replaceRegex" in x) for x in v
    )


def _normalize_view(v: Any) -> str | None:
    if v in ("user", "model"):
        return v
    if v == "user_view":
        return "user"
    if v in ("model_view", "assistant_view"):
        return "model"
    return None


def _normalize_target(v: Any) -> str | None:
    if v in ("userInput", "aiOutput", "slashCommands", "worldBook", "reasoning"):
        return v
    # legacy compatibility (match TS)
    if v == "user":
        return "userInput"
    if v in ("model", "assistant_response"):
        return "aiOutput"
    if v == "preset":
        return "slashCommands"
    if v == "world_book":
        return "worldBook"
    return None


def _to_array(v: Any) -> list[Any]:
    return v if isinstance(v, list) else []


def _normalize_one(item: Any) -> RegexScriptData | None:
    if not isinstance(item, dict):
        return None
    if "findRegex" not in item:
        return None

    script_id = str(item.get("id") or "")
    if not script_id:
        return None

    name = str(item.get("name") or "")
    enabled = item.get("enabled") is not False

    find_regex = str(item.get("findRegex") or "")
    replace_regex = str(item.get("replaceRegex") or "")

    trim_regex = [str(x) for x in _to_array(item.get("trimRegex"))]
    targets = [t for t in (_normalize_target(x) for x in _to_array(item.get("targets"))) if t]
    view = [t for t in (_normalize_view(x) for x in _to_array(item.get("view"))) if t]

    run_on_edit = bool(item.get("runOnEdit"))
    macro_mode_raw = str(item.get("macroMode") or "none")
    macro_mode = macro_mode_raw if macro_mode_raw in ("raw", "escaped", "none") else "none"

    min_depth = item.get("minDepth")
    if not (min_depth is None or isinstance(min_depth, (int, float))):
        min_depth = None
    min_depth = int(min_depth) if isinstance(min_depth, (int, float)) else None

    max_depth = item.get("maxDepth")
    if not (max_depth is None or isinstance(max_depth, (int, float))):
        max_depth = None
    max_depth = int(max_depth) if isinstance(max_depth, (int, float)) else None

    return {
        "id": script_id,
        "name": name,
        "enabled": bool(enabled),
        "findRegex": find_regex,
        "replaceRegex": replace_regex,
        "trimRegex": trim_regex,
        "targets": targets,  # type: ignore[typeddict-item]
        "view": view,  # type: ignore[typeddict-item]
        "runOnEdit": bool(run_on_edit),
        "macroMode": macro_mode,  # type: ignore[typeddict-item]
        "minDepth": min_depth,
        "maxDepth": max_depth,
    }


def normalize_regexes(input_value: RegexScriptsInput | None) -> list[RegexScriptData]:
    """
    Accepts multi-file inputs (align with TS normalizeRegexes):
    - RegexScriptData[]
    - { regexScripts: [...] }
    - { scripts: [...] }
    - RegexScriptData
    - array of the above (multi-file)
    """
    if input_value is None:
        return []

    files: list[RegexScriptsFileInput] = []

    if isinstance(input_value, list):
        if _is_regex_script_array(input_value):
            files.append(input_value)  # single-file: RegexScriptData[]
        else:
            files.extend(input_value)  # multi-file
    else:
        files.append(input_value)

    out: list[RegexScriptData] = []

    for item in files:
        if not item:
            continue

        if _is_regex_script_array(item):
            for s in item:
                n = _normalize_one(s)
                if n:
                    out.append(n)
            continue

        if isinstance(item, dict) and isinstance(item.get("regexScripts"), list):
            for s in item.get("regexScripts") or []:
                n = _normalize_one(s)
                if n:
                    out.append(n)
            continue

        if isinstance(item, dict) and isinstance(item.get("scripts"), list):
            for s in item.get("scripts") or []:
                n = _normalize_one(s)
                if n:
                    out.append(n)
            continue

        n = _normalize_one(item)
        if n:
            out.append(n)

    return out

