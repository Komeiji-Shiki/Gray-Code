from __future__ import annotations

from typing import Any

from ...types import WorldBookEntry, WorldBookInput, WorldBooksInput


def _is_worldbook_entry_array(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, dict) and ("content" in x) for x in v)


def _to_number(v: Any, fallback: float) -> float:
    try:
        n = float(v) if not isinstance(v, bool) else fallback
    except Exception:
        return fallback
    return n if n == n and n not in (float("inf"), float("-inf")) else fallback


def _to_bool(v: Any, fallback: bool) -> bool:
    return v if isinstance(v, bool) else fallback


def _normalize_one_entry(e: Any) -> WorldBookEntry | None:
    if not isinstance(e, dict):
        return None

    position = str(e.get("position") or "")
    if not position:
        return None

    index_n = _to_number(e.get("index"), float("nan"))
    if index_n != index_n:
        return None
    index = int(index_n)

    name = str(e.get("name") or "")
    content = str(e.get("content") or "")

    enabled = _to_bool(e.get("enabled"), True)

    activation_mode_raw = str(e.get("activationMode") or "keyword")
    activation_mode = activation_mode_raw if activation_mode_raw in ("always", "keyword", "vector") else "keyword"

    key = [str(x) for x in (e.get("key") or [])] if isinstance(e.get("key"), list) else []
    secondary_key = (
        [str(x) for x in (e.get("secondaryKey") or [])] if isinstance(e.get("secondaryKey"), list) else []
    )

    selective_logic_raw = str(e.get("selectiveLogic") or "andAny")
    selective_logic = (
        selective_logic_raw
        if selective_logic_raw in ("andAny", "andAll", "notAll", "notAny")
        else "andAny"
    )

    order_n = _to_number(e.get("order"), float("nan"))
    if order_n != order_n:
        return None
    order = int(order_n)

    depth_default = float("nan") if position == "fixed" else 0.0
    depth_n = _to_number(e.get("depth"), depth_default)
    if position == "fixed" and depth_n != depth_n:
        return None
    depth = int(depth_n) if depth_n == depth_n else 0

    role_raw = e.get("role")
    if role_raw is None:
        role = None
    else:
        role_s = str(role_raw or "")
        role = None if role_s == "" else role_s

    case_sensitive_raw = e.get("caseSensitive")
    case_sensitive = case_sensitive_raw if (case_sensitive_raw is None or isinstance(case_sensitive_raw, bool)) else None

    exclude_recursion = _to_bool(e.get("excludeRecursion"), False)
    prevent_recursion = _to_bool(e.get("preventRecursion"), False)

    probability_n = _to_number(e.get("probability"), 100.0)
    probability = int(probability_n) if probability_n == probability_n else 100

    other = e.get("other") if isinstance(e.get("other"), dict) else {}

    return {
        "index": index,
        "name": name,
        "content": content,
        "enabled": bool(enabled),
        "activationMode": activation_mode,  # type: ignore[typeddict-item]
        "key": key,
        "secondaryKey": secondary_key,
        "selectiveLogic": selective_logic,  # type: ignore[typeddict-item]
        "order": order,
        "depth": depth,
        "position": position,
        "role": role,  # type: ignore[typeddict-item]
        "caseSensitive": case_sensitive,
        "excludeRecursion": bool(exclude_recursion),
        "preventRecursion": bool(prevent_recursion),
        "probability": probability,
        "other": other,
    }


def _normalize_one(item: WorldBookInput) -> list[WorldBookEntry]:
    if _is_worldbook_entry_array(item):
        return [x for x in (_normalize_one_entry(e) for e in item) if x]

    if isinstance(item, dict) and isinstance(item.get("entries"), list):
        if item.get("enabled") is False:
            return []
        return [x for x in (_normalize_one_entry(e) for e in (item.get("entries") or [])) if x]

    return []


def normalize_worldbooks(input_value: WorldBooksInput | None) -> list[WorldBookEntry]:
    """
    Accepts multi-file inputs (align with TS normalizeWorldbooks):
    - WorldBook ({ name, entries })
    - WorldBookEntry[]
    - array of the above (multi-file)
    """
    if input_value is None:
        return []

    files: list[WorldBookInput] = []
    if isinstance(input_value, list):
        if _is_worldbook_entry_array(input_value):
            files.append(input_value)
        else:
            files.extend(input_value)
    else:
        files.append(input_value)

    out: list[WorldBookEntry] = []
    for f in files:
        if not f:
            continue
        out.extend(_normalize_one(f))
    return out

