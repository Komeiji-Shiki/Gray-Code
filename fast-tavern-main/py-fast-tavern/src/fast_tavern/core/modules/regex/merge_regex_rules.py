from __future__ import annotations

from ...types import RegexScriptData


def merge_regex_rules(params: dict) -> list[RegexScriptData]:
    # Align with TS: just concatenation; normalization is handled by normalize_regexes.
    all_scripts: list[RegexScriptData] = []
    all_scripts.extend(params.get("globalScripts") or [])
    all_scripts.extend(params.get("presetScripts") or [])
    all_scripts.extend(params.get("characterScripts") or [])
    return all_scripts

