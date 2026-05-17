from __future__ import annotations

import re
from typing import Any

from ...types import RegexScriptData, RegexTarget, RegexView


def _escape_regexp_literal(s: str) -> str:
    # close to JS escapeRegExpLiteral
    return re.sub(r"[.*+?^${}()|\[\]\\]", lambda m: "\\" + m.group(0), s)


def _replace_macro_tokens(pattern: str, macros: dict[str, str], mode: str) -> str:
    if mode == "none":
        return pattern

    def pick(key: str) -> str | None:
        if key in macros:
            return str(macros[key])
        lower = key.lower()
        if lower in macros:
            return str(macros[lower])
        return None

    def encode(v: str) -> str:
        return _escape_regexp_literal(v) if mode == "escaped" else v

    def repl(m: re.Match[str]) -> str:
        key = m.group(1)
        val = pick(key)
        return m.group(0) if val is None else encode(val)

    return re.sub(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}", repl, re.sub(r"<<\s*([a-zA-Z0-9_]+)\s*>>", repl, pattern))


def _parse_find_regex(input_value: str) -> tuple[str, str]:
    s = str(input_value or "")
    if s.startswith("/"):
        # try parse /pattern/flags, find last unescaped /
        for i in range(len(s) - 1, 0, -1):
            if s[i] != "/":
                continue
            backslashes = 0
            j = i - 1
            while j >= 0 and s[j] == "\\":
                backslashes += 1
                j -= 1
            if backslashes % 2 == 1:
                continue
            source = s[1:i]
            flags = s[i + 1 :]
            if re.fullmatch(r"[gimsuy]*", flags or ""):
                return source, flags
            break
    return s, ""


def _apply_trim(match: str, trims: list[str]) -> str:
    out = match
    for t in trims or []:
        needle = str(t or "")
        if not needle:
            continue
        out = "".join(out.split(needle))
    return out


def _interpolate_replacement(template: str, match_trimmed: str, groups: list[str]) -> str:
    raw = str(template or "")
    out = re.sub(r"\{\{\s*match\s*\}\}", match_trimmed, raw, flags=re.IGNORECASE)

    DOLLAR = "\u0000DOLLAR\u0000"
    out = out.replace("$$", DOLLAR)
    out = out.replace("$&", match_trimmed)

    def repl_group(m: re.Match[str]) -> str:
        n_str = m.group(1)
        try:
            n = int(n_str)
        except Exception:
            return ""
        if n <= 0:
            return ""
        return str(groups[n - 1] if (n - 1) < len(groups) else "")

    out = re.sub(r"\$(\d{1,2})", repl_group, out)
    out = out.replace(DOLLAR, "$")
    return out


def _should_apply_by_depth(script: RegexScriptData, target: RegexTarget, history_depth: int | None) -> bool:
    if target not in ("userInput", "aiOutput"):
        return True
    if history_depth is None:
        return False

    min_d = script.get("minDepth")
    max_d = script.get("maxDepth")
    min_d = None if (min_d is None or min_d == -1) else int(min_d)
    max_d = None if (max_d is None or max_d == -1) else int(max_d)

    if min_d is not None and history_depth < min_d:
        return False
    if max_d is not None and history_depth > max_d:
        return False
    return True


def _flags_to_re_flags(flags: str) -> tuple[int, bool]:
    re_flags = 0
    global_replace = False
    for ch in flags or "":
        if ch == "g":
            global_replace = True
        elif ch == "i":
            re_flags |= re.IGNORECASE
        elif ch == "m":
            re_flags |= re.MULTILINE
        elif ch == "s":
            re_flags |= re.DOTALL
        elif ch in ("u", "y"):
            # u: default in python3; y: sticky not supported (best-effort ignore)
            pass
    return re_flags, global_replace


def apply_regex(
    text: str,
    params: dict[str, Any],
) -> str:
    """
    Apply regex scripts (align with TS applyRegex):
    - targets/view filter
    - trimRegex + {{match}} / $& / $1..$99 / $$
    - Find Regex macro replacement (macroMode)
    - minDepth/maxDepth (only for chat history targets)
    """
    result = "" if text is None else str(text)
    macros: dict[str, str] = params.get("macros") or {}

    scripts: list[RegexScriptData] = params.get("scripts") or []
    target: RegexTarget = params.get("target")
    view: RegexView = params.get("view")
    history_depth: int | None = params.get("historyDepth")

    for script in scripts or []:
        if not script or not script.get("enabled"):
            continue
        if not isinstance(script.get("targets"), list) or len(script.get("targets") or []) == 0:
            continue
        if not isinstance(script.get("view"), list) or len(script.get("view") or []) == 0:
            continue
        if target not in (script.get("targets") or []):
            continue
        if view not in (script.get("view") or []):
            continue
        if not _should_apply_by_depth(script, target, history_depth):
            continue

        substituted = _replace_macro_tokens(str(script.get("findRegex") or ""), macros, str(script.get("macroMode") or "none"))
        source, flags = _parse_find_regex(substituted)
        re_flags, global_replace = _flags_to_re_flags(flags)

        try:
            compiled = re.compile(source, re_flags)
        except Exception:
            continue

        replace_template = str(script.get("replaceRegex") or "")
        trims = script.get("trimRegex") if isinstance(script.get("trimRegex"), list) else []
        trims = [str(x) for x in (trims or [])]

        def repl(m: re.Match[str]) -> str:
            match = m.group(0) or ""
            groups = [g if g is not None else "" for g in m.groups()]
            match_trimmed = _apply_trim(match, trims)
            return _interpolate_replacement(replace_template, match_trimmed, groups)

        count = 0 if global_replace else 1
        result = compiled.sub(repl, result, count=count)

    return result

