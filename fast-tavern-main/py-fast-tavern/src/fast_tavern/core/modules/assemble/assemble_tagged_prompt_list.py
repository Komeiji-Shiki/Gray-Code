from __future__ import annotations

from typing import Any

from ...types import PromptInfo, Role, TaggedContent, WorldBookEntry


def _normalize_role(raw: Any, fallback: Role = "system") -> Role:
    r = str(raw or "").lower()
    if r == "system":
        return "system"
    if r == "user":
        return "user"
    if r in ("model", "assistant"):
        return "model"
    return fallback


def _is_fixed_prompt(p: PromptInfo) -> bool:
    return p.get("position") == "fixed"


def _is_fixed_worldbook_entry(e: WorldBookEntry) -> bool:
    return str(e.get("position")) == "fixed"


def assemble_tagged_prompt_list(params: dict[str, Any]) -> list[TaggedContent]:
    preset_prompts: list[PromptInfo] = params.get("presetPrompts") or []
    active_entries: list[WorldBookEntry] = params.get("activeEntries") or []
    chat_history: list[dict[str, Any]] = params.get("chatHistory") or []

    position_map: dict[str, str] = params.get("positionMap") or {"beforeChar": "charBefore", "afterChar": "charAfter"}
    chat_history_identifier: str = params.get("chatHistoryIdentifier") or "chatHistory"

    result: list[TaggedContent] = []

    enabled_prompts = [p for p in (preset_prompts or []) if p and p.get("enabled") is not False]
    relative_prompts = [p for p in enabled_prompts if p.get("position") == "relative"]

    for prompt in relative_prompts:
        # 1) worldbook slot entries (position != fixed)
        slot_entries = [
            e
            for e in (active_entries or [])
            if e
            and (not _is_fixed_worldbook_entry(e))
            and (position_map.get(str(e.get("position"))) or str(e.get("position"))) == str(prompt.get("identifier"))
        ]
        slot_entries.sort(key=lambda x: int(x.get("order") or 0))

        for entry in slot_entries:
            result.append(
                {
                    "tag": f"Worldbook: {entry.get('name')}",
                    "target": "worldBook",
                    "role": _normalize_role(entry.get("role") if entry.get("role") is not None else "system", "system"),
                    "text": str(entry.get("content") or ""),
                }
            )

        # 2) main content
        if str(prompt.get("identifier")) == chat_history_identifier:
            dialogue_list: list[TaggedContent] = []
            for node in chat_history or []:
                role: Role = node.get("role")
                text = str(node.get("text") or "")
                target = (
                    "userInput"
                    if role == "user"
                    else "aiOutput"
                    if role == "model"
                    else "slashCommands"
                )
                item: TaggedContent = {
                    "tag": f"History: {role}",
                    "target": target,  # type: ignore[typeddict-item]
                    "role": role,
                    "text": text,
                }
                if node.get("historyDepth") is not None:
                    item["historyDepth"] = int(node.get("historyDepth"))
                dialogue_list.append(item)

            preset_injections = [
                p
                for p in enabled_prompts
                if _is_fixed_prompt(p)
                and isinstance(p.get("depth"), (int, float))
                and isinstance(p.get("order"), (int, float))
            ]
            worldbook_injections = [
                e
                for e in (active_entries or [])
                if e
                and _is_fixed_worldbook_entry(e)
                and isinstance(e.get("depth"), (int, float))
                and isinstance(e.get("order"), (int, float))
            ]

            all_injections: list[dict[str, Any]] = []
            for idx, p in enumerate(preset_injections):
                all_injections.append(
                    {
                        "tag": f"Preset: {p.get('name')}",
                        "target": "slashCommands",
                        "role": _normalize_role(p.get("role"), "system"),
                        "text": p.get("content") or "",
                        "depth": int(p.get("depth")),
                        "order": int(p.get("order")),
                        "idx": idx,
                    }
                )
            for idx, e in enumerate(worldbook_injections):
                all_injections.append(
                    {
                        "tag": f"Worldbook: {e.get('name')}",
                        "target": "worldBook",
                        "role": _normalize_role(e.get("role") if e.get("role") is not None else "system", "system"),
                        "text": e.get("content") or "",
                        "depth": int(e.get("depth")),
                        "order": int(e.get("order")),
                        "idx": 10_000 + idx,
                    }
                )

            # 同 depth 条目 insert 到同一位置时，后插入的排在前面，
            # 因此需反转 order/idx 排序，保证最终输出中 order 小的在前
            all_injections.sort(key=lambda x: (x["depth"], -x["order"], -x["idx"]))

            original_count = len(dialogue_list)
            for item in all_injections:
                target_index = max(0, original_count - int(item["depth"]))
                dialogue_list.insert(
                    target_index,
                    {
                        "tag": item["tag"],
                        "target": item["target"],  # type: ignore[typeddict-item]
                        "role": item["role"],
                        "text": item["text"],
                    },
                )

            result.extend(dialogue_list)
            continue

        if prompt.get("content"):
            result.append(
                {
                    "tag": f"Preset: {prompt.get('name')}",
                    "target": "slashCommands",
                    "role": _normalize_role(prompt.get("role"), "system"),
                    "text": str(prompt.get("content")),
                }
            )

    return result

