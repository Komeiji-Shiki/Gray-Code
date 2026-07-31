from __future__ import annotations

from typing import Any, Callable

from ...types import WorldBook, WorldBookEntry
from ..inputs import normalize_worldbooks


def _normalize_probability(p: Any) -> float:
    try:
        n = float(p)
    except Exception:
        return 100.0
    if n != n:
        return 100.0
    return max(0.0, min(100.0, n))


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _to_recursion_limit(v: Any) -> int:
    """Math.trunc 语义：字符串/浮点字符串可解析；NaN → -1（range 空，循环不执行）"""
    if v is None or isinstance(v, bool):
        return 5
    try:
        n = float(v)
    except Exception:
        # TS: Number("abc") = NaN -> Math.trunc(NaN) = NaN -> 循环不执行 -> 等价 -1
        return -1
    if n != n:
        return -1
    if n == float("inf"):
        return 5
    if n == float("-inf"):
        # TS: Math.trunc(-Infinity) = -Infinity -> range 空（0 次迭代）
        return -1
    # Math.trunc 语义：不钳制负数，int(-2.5) = -2 -> range(0, -1) 为空
    return int(n)


def _normalize_case_sensitive(entry: WorldBookEntry, default_case_sensitive: bool) -> bool:
    if isinstance(entry.get("caseSensitive"), bool):
        return bool(entry.get("caseSensitive"))
    return default_case_sensitive


def _includes_keyword(text: str, keyword: str, case_sensitive: bool) -> bool:
    if not keyword:
        return False
    if case_sensitive:
        return keyword in text
    return keyword.lower() in text.lower()


def _any_included(text: str, keywords: list[str], case_sensitive: bool) -> bool:
    return any(_includes_keyword(text, k, case_sensitive) for k in (keywords or []))


def _all_included(text: str, keywords: list[str], case_sensitive: bool) -> bool:
    lst = [k for k in (keywords or []) if k]
    if len(lst) == 0:
        return True
    return all(_includes_keyword(text, k, case_sensitive) for k in lst)


def _secondary_logic_pass(logic: str, text: str, secondary: list[str], case_sensitive: bool) -> bool:
    lst = [k for k in (secondary or []) if k]
    if len(lst) == 0:
        return True

    if logic == "andAny":
        return _any_included(text, lst, case_sensitive)
    if logic == "andAll":
        return _all_included(text, lst, case_sensitive)
    if logic == "notAny":
        return not _any_included(text, lst, case_sensitive)
    if logic == "notAll":
        return not _all_included(text, lst, case_sensitive)
    return _any_included(text, lst, case_sensitive)


def _keyword_triggered(entry: WorldBookEntry, text: str, case_sensitive: bool) -> bool:
    primary = [k for k in (entry.get("key") or []) if k]
    primary_list = primary if len(primary) > 0 else [k for k in (entry.get("secondaryKey") or []) if k]
    if len(primary_list) == 0:
        return False

    primary_hit = _any_included(text, primary_list, case_sensitive)
    if not primary_hit:
        return False

    if len(entry.get("key") or []) > 0:
        return _secondary_logic_pass(entry.get("selectiveLogic"), text, entry.get("secondaryKey") or [], case_sensitive)

    return True


def _as_set(v: Any) -> set[Any]:
    if v is None:
        return set()
    if isinstance(v, set):
        return set(x for x in v if _is_number(x))
    if isinstance(v, list):
        return set(x for x in v if _is_number(x) and float(x) == float(x))
    return set()


def get_active_entries(params: dict[str, Any]) -> list[WorldBookEntry]:
    """
    Align with TS getActiveEntries (sync).

    params:
      - contextText?: str
      - globalEntries?: WorldBookEntry[]
      - characterWorldBook?: WorldBook | None
      - options?: { vectorSearch?, recursionLimit?, rng?, defaultCaseSensitive? }
    """
    context_text = str(params.get("contextText") or "")
    global_entries = params.get("globalEntries") or []
    character_worldbook: WorldBook | None = params.get("characterWorldBook")
    options = params.get("options") or {}

    default_case_sensitive = bool(options.get("defaultCaseSensitive")) if "defaultCaseSensitive" in options else False
    recursion_limit = _to_recursion_limit(options.get("recursionLimit"))

    rng: Callable[[], float] = options.get("rng") or __import__("random").random

    all_nodes: list[dict[str, Any]] = []
    for idx, e in enumerate(global_entries or []):
        if not e:
            continue
        all_nodes.append({"entry": e, "source": "global", "prio": 1, "seq": idx})

    if character_worldbook:
        lst = normalize_worldbooks(character_worldbook)
        for idx, e in enumerate(lst):
            if not e:
                continue
            all_nodes.append({"entry": e, "source": "character", "prio": 2, "seq": idx})

    vector_hits: set[int] = set()
    vector_search = options.get("vectorSearch")
    if callable(vector_search):
        try:
            res = vector_search({"entries": [x["entry"] for x in all_nodes], "contextText": context_text})
            vector_hits = _as_set(res)
        except Exception:
            vector_hits = set()

    by_index: dict[int, dict[str, Any]] = {}
    prob_failed: set[int] = set()
    recursion_context = context_text

    def consider(entry: WorldBookEntry, iteration: int) -> bool:
        if not entry.get("enabled"):
            return False

        ctx = context_text if (iteration > 0 and entry.get("excludeRecursion")) else recursion_context
        case_sensitive = _normalize_case_sensitive(entry, default_case_sensitive)

        mode = entry.get("activationMode")
        if mode == "always":
            return True
        if mode == "keyword":
            return _keyword_triggered(entry, ctx, case_sensitive)
        if mode == "vector":
            return entry.get("index") in vector_hits
        return False

    def pass_probability(entry: WorldBookEntry) -> bool:
        p = _normalize_probability(entry.get("probability"))
        if p >= 100:
            return True
        if p <= 0:
            return False
        return rng() * 100.0 < p

    for iteration in range(0, recursion_limit + 1):
        any_new = False

        for node in all_nodes:
            entry = node.get("entry")
            if not entry:
                continue
            idx = entry.get("index")
            if not _is_number(idx):
                continue
            if idx in by_index:
                continue
            if idx in prob_failed:
                continue

            if not consider(entry, iteration):
                continue

            if not pass_probability(entry):
                prob_failed.add(idx)
                continue

            by_index[idx] = {"entry": entry, "prio": node.get("prio"), "seq": node.get("seq")}
            any_new = True

            if not entry.get("preventRecursion") and entry.get("content"):
                recursion_context = (
                    f"{recursion_context}\n{entry.get('content')}" if recursion_context else str(entry.get("content"))
                )

        if not any_new:
            break

    active = list(by_index.values())

    def sort_key(x: dict[str, Any]):
        e = x["entry"]
        order = e.get("order")
        try:
            # order 宽容解析：保留小数（对齐 TS number）
            order_f = float(order)  # type: ignore[arg-type]
        except Exception:
            order_f = 0.0
        if order_f != order_f:
            order_f = 0.0
        return (order_f, int(x.get("prio") or 0), int(x.get("seq") or 0))

    active.sort(key=sort_key)
    return [x["entry"] for x in active]

