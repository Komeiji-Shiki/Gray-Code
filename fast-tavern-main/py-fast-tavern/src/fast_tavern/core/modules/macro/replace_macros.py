from __future__ import annotations

import re
from typing import Any

from ..variables import process_variable_macros


def replace_macros(text: str, options: dict[str, Any] | dict[str, str]) -> str:
    """
    Macro replacement (align with TS replaceMacros):
    - {{key}} / <<key>> (any alnum/_ token)
    - variable macros handled first if variableContext provided:
      {{getvar::...}}/{{setvar::...}}/{{getglobalvar::...}}/{{setglobalvar::...}}
      and <<...>> variants.
    """
    if not text:
        return ""

    # Back-compat: `options` could be a plain macros dict
    opts: dict[str, Any]
    if isinstance(options, dict) and ("macros" in options or "variableContext" in options):
        opts = options
    else:
        opts = {"macros": options}

    macros: dict[str, str] = dict(opts.get("macros") or {})
    out = text

    # 1) variable macros
    if opts.get("variableContext") is not None:
        out = process_variable_macros(out, opts["variableContext"])

    # 2) <<key>>
    def repl_angle(m: re.Match[str]) -> str:
        key = m.group(1)
        lower_key = key.lower()
        if key in macros:
            return str(macros[key])
        if lower_key in macros:
            return str(macros[lower_key])
        return m.group(0)

    out = re.sub(r"<<\s*([a-zA-Z0-9_]+)\s*>>", repl_angle, out)

    # 3) {{key}} excluding variable macro keywords
    def repl_brace(m: re.Match[str]) -> str:
        key = m.group(1)
        lower_key = key.lower()
        if lower_key in ("getvar", "setvar", "getglobalvar", "setglobalvar"):
            return m.group(0)
        if key in macros:
            return str(macros[key])
        if lower_key in macros:
            return str(macros[lower_key])
        return m.group(0)

    out = re.sub(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}", repl_brace, out)
    return out

