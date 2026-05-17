from __future__ import annotations

import json
import re
from typing import Any, Literal, TypedDict, cast


VariableScope = Literal["local", "global"]

VariableContext = TypedDict(
    "VariableContext",
    {
        "local": dict[str, Any],
        "global": dict[str, Any],
    },
)


def create_variable_context(
    initial_local: dict[str, Any] | None = None,
    initial_global: dict[str, Any] | None = None,
) -> VariableContext:
    return {"local": dict(initial_local or {}), "global": dict(initial_global or {})}


def _pick_store(ctx: VariableContext, scope: VariableScope | None) -> dict[str, Any]:
    return ctx["global"] if (scope or "local") == "global" else ctx["local"]


def get_var(ctx: VariableContext, name: str) -> Any:
    return ctx["local"].get(name, "")


def set_var(ctx: VariableContext, name: str, value: Any) -> None:
    ctx["local"][name] = value


def get_global_var(ctx: VariableContext, name: str) -> Any:
    return ctx["global"].get(name, "")


def set_global_var(ctx: VariableContext, name: str, value: Any) -> None:
    ctx["global"][name] = value


def variables_get(ctx: VariableContext, input_value: dict[str, Any]):
    store = _pick_store(ctx, cast(VariableScope | None, input_value.get("scope")))
    return {"value": store.get(str(input_value.get("name") or ""))}


def variables_list(ctx: VariableContext, input_value: dict[str, Any] | None = None):
    store = _pick_store(ctx, cast(VariableScope | None, (input_value or {}).get("scope")))
    return {"variables": dict(store)}


def variables_set(ctx: VariableContext, input_value: dict[str, Any]):
    store = _pick_store(ctx, cast(VariableScope | None, input_value.get("scope")))
    store[str(input_value.get("name") or "")] = input_value.get("value")
    return {"ok": True}


def variables_delete(ctx: VariableContext, input_value: dict[str, Any]):
    store = _pick_store(ctx, cast(VariableScope | None, input_value.get("scope")))
    store.pop(str(input_value.get("name") or ""), None)
    return {"ok": True}


def variables_add(ctx: VariableContext, input_value: dict[str, Any]):
    store = _pick_store(ctx, cast(VariableScope | None, input_value.get("scope")))
    name = str(input_value.get("name") or "")
    cur = store.get(name)
    add_val = input_value.get("value")

    next_val: Any
    if cur is None and name not in store:
        next_val = add_val
    else:
        try:
            cur_num = float(cur)  # type: ignore[arg-type]
            add_num = float(add_val)  # type: ignore[arg-type]
            if cur_num == cur_num and add_num == add_num:
                # preserve int-ish results when possible
                summed = cur_num + add_num
                next_val = int(summed) if float(int(summed)) == summed else summed
            else:
                next_val = f"{cur or ''}{add_val or ''}"
        except Exception:
            next_val = f"{'' if cur is None else cur}{'' if add_val is None else add_val}"

    store[name] = next_val
    return {"ok": True}


def variables_inc(ctx: VariableContext, input_value: dict[str, Any]):
    store = _pick_store(ctx, cast(VariableScope | None, input_value.get("scope")))
    name = str(input_value.get("name") or "")
    cur = store.get(name)
    try:
        cur_num = float(cur)  # type: ignore[arg-type]
        store[name] = (cur_num if cur_num == cur_num else 0) + 1
    except Exception:
        store[name] = 1
    return {"ok": True}


def variables_dec(ctx: VariableContext, input_value: dict[str, Any]):
    store = _pick_store(ctx, cast(VariableScope | None, input_value.get("scope")))
    name = str(input_value.get("name") or "")
    cur = store.get(name)
    try:
        cur_num = float(cur)  # type: ignore[arg-type]
        store[name] = (cur_num if cur_num == cur_num else 0) - 1
    except Exception:
        store[name] = -1
    return {"ok": True}


class Variables:
    get = staticmethod(variables_get)
    list = staticmethod(variables_list)
    set = staticmethod(variables_set)
    delete = staticmethod(variables_delete)
    add = staticmethod(variables_add)
    inc = staticmethod(variables_inc)
    dec = staticmethod(variables_dec)


def _stringify_variable_value(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    # Align with JS String(true/false) => "true"/"false"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    try:
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return str(v)


def process_variable_macros(text: str, ctx: VariableContext) -> str:
    if not text:
        return ""

    result = text

    # {{setvar::name::value}} must be processed before gets
    result = re.sub(
        r"\{\{\s*setvar\s*::\s*([^:}]+)\s*::\s*([^}]*)\s*\}\}",
        lambda m: (set_var(ctx, m.group(1).strip(), m.group(2).strip()) or ""),  # type: ignore[func-returns-value]
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\{\{\s*setglobalvar\s*::\s*([^:}]+)\s*::\s*([^}]*)\s*\}\}",
        lambda m: (set_global_var(ctx, m.group(1).strip(), m.group(2).strip()) or ""),  # type: ignore[func-returns-value]
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\{\{\s*getvar\s*::\s*([^}]+)\s*\}\}",
        lambda m: _stringify_variable_value(get_var(ctx, m.group(1).strip())),
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\{\{\s*getglobalvar\s*::\s*([^}]+)\s*\}\}",
        lambda m: _stringify_variable_value(get_global_var(ctx, m.group(1).strip())),
        result,
        flags=re.IGNORECASE,
    )

    # <<setvar::name::value>> / <<getvar::name>>
    result = re.sub(
        r"<<\s*setvar\s*::\s*([^:>]+)\s*::\s*([^>]*)\s*>>",
        lambda m: (set_var(ctx, m.group(1).strip(), m.group(2).strip()) or ""),  # type: ignore[func-returns-value]
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"<<\s*setglobalvar\s*::\s*([^:>]+)\s*::\s*([^>]*)\s*>>",
        lambda m: (set_global_var(ctx, m.group(1).strip(), m.group(2).strip()) or ""),  # type: ignore[func-returns-value]
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"<<\s*getvar\s*::\s*([^>]+)\s*>>",
        lambda m: _stringify_variable_value(get_var(ctx, m.group(1).strip())),
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"<<\s*getglobalvar\s*::\s*([^>]+)\s*>>",
        lambda m: _stringify_variable_value(get_global_var(ctx, m.group(1).strip())),
        result,
        flags=re.IGNORECASE,
    )

    return result


def get_variable_changes(original: VariableContext, current: VariableContext) -> dict[str, dict[str, Any]]:
    local_changes: dict[str, Any] = {}
    global_changes: dict[str, Any] = {}

    for k, v in (current.get("local") or {}).items():
        if (original.get("local") or {}).get(k) != v:
            local_changes[k] = v

    for k, v in (current.get("global") or {}).items():
        if (original.get("global") or {}).get(k) != v:
            global_changes[k] = v

    return {"localChanges": local_changes, "globalChanges": global_changes}


__all__ = [
    "VariableContext",
    "VariableScope",
    "create_variable_context",
    "get_var",
    "set_var",
    "get_global_var",
    "set_global_var",
    "Variables",
    "process_variable_macros",
    "get_variable_changes",
]

