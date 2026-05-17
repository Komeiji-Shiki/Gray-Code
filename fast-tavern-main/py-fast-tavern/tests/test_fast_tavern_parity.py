from __future__ import annotations

import math

from fast_tavern import (
    History,
    Variables,
    build_prompt,
    build_prompt_from_silly_tavern,
    convert_character_from_silly_tavern,
    convert_history_from_silly_tavern,
    convert_preset_from_silly_tavern,
    convert_regex_from_silly_tavern,
    convert_worldbook_from_silly_tavern,
    convert_messages_in,
    convert_messages_out,
    create_variable_context,
    normalize_regexes,
    normalize_worldbooks,
)


def make_preset():
    return {
        "name": "Preset Test",
        "utilityPrompts": {},
        "other": {},
        "regexScripts": [],
        "prompts": [
            {
                "identifier": "charBefore",
                "name": "Char Before",
                "enabled": True,
                "role": "system",
                "content": "SYSTEM: before char",
                "position": "relative",
                "depth": 0,
                "order": 0,
                "trigger": [],
            },
            {
                "identifier": "main",
                "name": "Main",
                "enabled": True,
                "role": "system",
                "content": "Hello {{user}} <X>",
                "position": "relative",
                "depth": 0,
                "order": 0,
                "trigger": [],
            },
            {
                "identifier": "chatHistory",
                "name": "Chat History",
                "enabled": True,
                "role": "system",
                "content": "",
                "position": "relative",
                "depth": 0,
                "order": 0,
                "trigger": [],
            },
            {
                "identifier": "charAfter",
                "name": "Char After",
                "enabled": True,
                "role": "system",
                "content": "SYSTEM: after char",
                "position": "relative",
                "depth": 0,
                "order": 0,
                "trigger": [],
            },
            # fixed injection: depth=1 -> before last history item
            {
                "identifier": "inject1",
                "name": "Inject",
                "enabled": True,
                "role": "system",
                "position": "fixed",
                "depth": 1,
                "order": 0,
                "trigger": [],
                "content": "INJECTED",
            },
        ],
    }


def make_worldbooks_multi_file():
    wb_file1 = {
        "name": "wb-1",
        "entries": [
            {
                "index": 1,
                "name": "WB Before",
                "content": "WB_BEFORE",
                "enabled": True,
                "activationMode": "always",
                "key": [],
                "secondaryKey": [],
                "selectiveLogic": "andAny",
                "order": 0,
                "depth": 0,
                "position": "beforeChar",
                "role": None,
                "caseSensitive": False,
                "excludeRecursion": False,
                "preventRecursion": False,
                "probability": 100,
                "other": {},
            }
        ],
    }

    wb_entries2 = [
        {
            "index": 2,
            "name": "WB Keyword",
            "content": "WB_COND",
            "enabled": True,
            "activationMode": "keyword",
            "key": ["trigger"],
            "secondaryKey": [],
            "selectiveLogic": "andAny",
            "order": 1,
            "depth": 0,
            "position": "beforeChar",
            "role": None,
            "caseSensitive": False,
            "excludeRecursion": False,
            "preventRecursion": False,
            "probability": 100,
            "other": {},
        }
    ]

    return [wb_file1, wb_entries2]


def make_regexes_multi_file():
    file1 = {
        "regexScripts": [
            {
                "id": "user-only",
                "name": "user-only",
                "enabled": True,
                "findRegex": "Bob",
                "replaceRegex": "USER_VIEW_REPLACED",
                "trimRegex": [],
                "targets": ["slashCommands"],
                "view": ["user"],
                "runOnEdit": False,
                "macroMode": "none",
                "minDepth": None,
                "maxDepth": None,
            }
        ]
    }

    file2 = [
        {
            "id": "x-to-y",
            "name": "x-to-y",
            "enabled": True,
            "findRegex": "<X>",
            "replaceRegex": "<Y>",
            "trimRegex": [],
            "targets": ["slashCommands"],
            "view": ["model"],
            "runOnEdit": False,
            "macroMode": "none",
            "minDepth": None,
            "maxDepth": None,
        },
        {
            "id": "y-to-z",
            "name": "y-to-z",
            "enabled": True,
            "findRegex": "<Y>",
            "replaceRegex": "Z",
            "trimRegex": [],
            "targets": ["slashCommands"],
            "view": ["model"],
            "runOnEdit": False,
            "macroMode": "none",
            "minDepth": None,
            "maxDepth": None,
        },
        {
            "id": "inject-fix",
            "name": "inject-fix",
            "enabled": True,
            "findRegex": "INJECTED",
            "replaceRegex": "INJECTED_OK",
            "trimRegex": [],
            "targets": ["slashCommands", "userInput", "aiOutput"],
            "view": ["model", "user"],
            "runOnEdit": False,
            "macroMode": "none",
            "minDepth": None,
            "maxDepth": None,
        },
    ]

    return [file1, file2]


def make_worldbooks_for_order_test():
    return [
        {
            "name": "wb-order",
            "entries": [
                {
                    "index": 11,
                    "name": "WB Order 2",
                    "content": "WB_ORDER_2",
                    "enabled": True,
                    "activationMode": "always",
                    "key": [],
                    "secondaryKey": [],
                    "selectiveLogic": "andAny",
                    "order": 2,
                    "depth": 0,
                    "position": "beforeChar",
                    "role": None,
                    "caseSensitive": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "probability": 100,
                    "other": {},
                },
                {
                    "index": 10,
                    "name": "WB Order 1",
                    "content": "WB_ORDER_1",
                    "enabled": True,
                    "activationMode": "always",
                    "key": [],
                    "secondaryKey": [],
                    "selectiveLogic": "andAny",
                    "order": 1,
                    "depth": 0,
                    "position": "beforeChar",
                    "role": None,
                    "caseSensitive": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "probability": 100,
                    "other": {},
                },
            ],
        }
    ]


def make_preset_for_depth_order_test():
    return {
        "name": "Preset Depth/Order Test",
        "utilityPrompts": {},
        "other": {},
        "regexScripts": [],
        "prompts": [
            {
                "identifier": "chatHistory",
                "name": "Chat History",
                "enabled": True,
                "role": "system",
                "content": "",
                "position": "relative",
                "depth": 0,
                "order": 0,
                "trigger": [],
            },
            {
                "identifier": "p_d1_o10",
                "name": "P D1 O10",
                "enabled": True,
                "role": "system",
                "position": "fixed",
                "depth": 1,
                "order": 10,
                "trigger": [],
                "content": "P_D1_O10",
            },
            {
                "identifier": "p_missing_order",
                "name": "P missing order",
                "enabled": True,
                "role": "system",
                "position": "fixed",
                "depth": 1,
                "trigger": [],
                "content": "P_MISSING_ORDER_SHOULD_NOT_APPEAR",
            },
            {
                "identifier": "p_d1_o5",
                "name": "P D1 O5",
                "enabled": True,
                "role": "system",
                "position": "fixed",
                "depth": 1,
                "order": 5,
                "trigger": [],
                "content": "P_D1_O5",
            },
            {
                "identifier": "p_d2_o0",
                "name": "P D2 O0",
                "enabled": True,
                "role": "system",
                "position": "fixed",
                "depth": 2,
                "order": 0,
                "trigger": [],
                "content": "P_D2_O0",
            },
        ],
    }


def make_worldbooks_for_depth_order_injections():
    return [
        {
            "name": "wb-inject",
            "entries": [
                {
                    "index": 21,
                    "name": "W D1 O0",
                    "content": "W_D1_O0",
                    "enabled": True,
                    "activationMode": "always",
                    "key": [],
                    "secondaryKey": [],
                    "selectiveLogic": "andAny",
                    "order": 0,
                    "depth": 1,
                    "position": "fixed",
                    "role": "system",
                    "caseSensitive": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "probability": 100,
                    "other": {},
                },
                {
                    "index": 22,
                    "name": "W D2 O1",
                    "content": "W_D2_O1",
                    "enabled": True,
                    "activationMode": "always",
                    "key": [],
                    "secondaryKey": [],
                    "selectiveLogic": "andAny",
                    "order": 1,
                    "depth": 2,
                    "position": "fixed",
                    "role": "system",
                    "caseSensitive": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "probability": 100,
                    "other": {},
                },
                {
                    "index": 23,
                    "name": "W D2 O2",
                    "content": "W_D2_O2",
                    "enabled": True,
                    "activationMode": "always",
                    "key": [],
                    "secondaryKey": [],
                    "selectiveLogic": "andAny",
                    "order": 2,
                    "depth": 2,
                    "position": "fixed",
                    "role": "system",
                    "caseSensitive": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "probability": 100,
                    "other": {},
                },
                {
                    "index": 24,
                    "name": "W fixed no depth",
                    "content": "W_FIXED_NO_DEPTH_SHOULD_NOT_APPEAR",
                    "enabled": True,
                    "activationMode": "always",
                    "key": [],
                    "secondaryKey": [],
                    "selectiveLogic": "andAny",
                    "order": 999,
                    "depth": float("nan"),
                    "position": "fixed",
                    "role": "system",
                    "caseSensitive": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "probability": 100,
                    "other": {},
                },
                {
                    "index": 25,
                    "name": "W fixed no order",
                    "content": "W_FIXED_NO_ORDER_SHOULD_NOT_APPEAR",
                    "enabled": True,
                    "activationMode": "always",
                    "key": [],
                    "secondaryKey": [],
                    "selectiveLogic": "andAny",
                    "order": float("nan"),
                    "depth": 1,
                    "position": "fixed",
                    "role": "system",
                    "caseSensitive": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "probability": 100,
                    "other": {},
                },
                {
                    "index": 26,
                    "name": "W beforeChar with depth",
                    "content": "W_BEFORE_CHAR_WITH_DEPTH",
                    "enabled": True,
                    "activationMode": "always",
                    "key": [],
                    "secondaryKey": [],
                    "selectiveLogic": "andAny",
                    "order": 0,
                    "depth": 2,
                    "position": "beforeChar",
                    "role": None,
                    "caseSensitive": False,
                    "excludeRecursion": False,
                    "preventRecursion": False,
                    "probability": 100,
                    "other": {},
                },
            ],
        }
    ]


def simulate_depth_insert(base_texts, injections):
    lst = list(base_texts)
    original_count = len(lst)
    for inj in injections:
        idx = max(0, original_count - inj["depth"])
        lst.insert(idx, inj["text"])
    return lst


def find_tagged_by_tag(stage_tagged, contains: str):
    for item in stage_tagged:
        if contains in str(item.get("tag")):
            return item
    raise AssertionError(f"Expected tagged item whose tag includes: {contains}")


def assert_has_stages(obj: dict, label: str):
    for key in ("raw", "afterPreRegex", "afterMacro", "afterPostRegex"):
        assert key in obj, f"{label} should have stage: {key}"


def test_normalize_worldbooks_single_entries_array():
    wb_entries = make_worldbooks_multi_file()[0]["entries"]
    out = normalize_worldbooks(wb_entries)
    assert len(out) == 1
    assert out[0]["name"] == "WB Before"


def test_normalize_worldbooks_multi_file():
    out = normalize_worldbooks(make_worldbooks_multi_file())
    assert len(out) == 2
    assert [e["name"] for e in out] == ["WB Before", "WB Keyword"]


def test_normalize_regexes_multi_file():
    out = normalize_regexes(make_regexes_multi_file())
    assert len(out) == 4
    assert [r["id"] for r in out] == ["user-only", "x-to-y", "y-to-z", "inject-fix"]

def test_convert_regex_from_silly_tavern_legacy_mapping():
    out = convert_regex_from_silly_tavern(
        {
            "id": "r-old",
            "scriptName": "legacy-regex",
            "disabled": False,
            "findRegex": "hello",
            "replaceString": "HELLO",
            "trimStrings": ["xx"],
            "placement": [2],
            "markdownOnly": True,
            "promptOnly": False,
            "runOnEdit": True,
            "substituteRegex": 2,
            "minDepth": 1,
            "maxDepth": 9,
        }
    )

    assert out["id"] == "r-old"
    assert out["name"] == "legacy-regex"
    assert out["enabled"] is True
    assert out["replaceRegex"] == "HELLO"
    assert out["trimRegex"] == ["xx"]
    assert out["targets"] == ["aiOutput"]
    assert out["view"] == ["user"]
    assert out["macroMode"] == "escaped"
    assert out["minDepth"] == 1
    assert out["maxDepth"] == 9


def test_convert_worldbook_from_silly_tavern_legacy_mapping():
    out = convert_worldbook_from_silly_tavern(
        {
            "name": "LegacyWB",
            "entries": {
                1: {
                    "uid": 1,
                    "comment": "Legacy Entry",
                    "content": "Legacy Content",
                    "disable": True,
                    "constant": False,
                    "vectorized": True,
                    "key": ["k1"],
                    "keysecondary": ["k2"],
                    "selectiveLogic": 3,
                    "order": 7,
                    "depth": 4,
                    "position": 4,
                    "role": 2,
                    "caseSensitive": None,
                    "excludeRecursion": True,
                    "preventRecursion": False,
                    "probability": 88,
                    "custom": "x",
                }
            },
        }
    )

    assert out["name"] == "LegacyWB"
    assert len(out["entries"]) == 1

    e = out["entries"][0]
    assert e["name"] == "Legacy Entry"
    assert e["enabled"] is False
    assert e["activationMode"] == "vector"
    assert e["key"] == ["k1"]
    assert e["secondaryKey"] == ["k2"]
    assert e["selectiveLogic"] == "andAll"
    assert e["position"] == "fixed"
    assert e["role"] == "model"
    assert e["probability"] == 88
    assert e["other"]["custom"] == "x"


def test_convert_preset_from_silly_tavern_legacy_mapping():
    out = convert_preset_from_silly_tavern(
        {
            "name": "Legacy Preset",
            "temp": 1.2,
            "new_chat_prompt": "[Start a new Chat]",
            "prompts": [
                {
                    "identifier": "main",
                    "name": "Main",
                    "enabled": True,
                    "role": "system",
                    "content": "Hello",
                    "injection_depth": 2,
                    "injection_order": 5,
                    "injection_trigger": ["x"],
                    "injection_position": 1,
                }
            ],
            "prompt_order": [{"character_id": 100001, "order": [{"identifier": "main", "enabled": False}]}],
            "extensions": {
                "regex_scripts": [
                    {
                        "id": "preset-r-1",
                        "scriptName": "preset-regex",
                        "disabled": False,
                        "findRegex": "A",
                        "replaceString": "B",
                        "trimStrings": [],
                        "placement": [3],
                        "markdownOnly": False,
                        "promptOnly": True,
                        "runOnEdit": False,
                        "substituteRegex": 1,
                        "minDepth": None,
                        "maxDepth": None,
                    }
                ]
            },
        }
    )

    assert out["name"] == "Legacy Preset"
    assert len(out["prompts"]) == 1
    assert out["prompts"][0]["enabled"] is False
    assert out["prompts"][0]["index"] == 0
    assert out["prompts"][0]["depth"] == 2
    assert out["prompts"][0]["order"] == 5
    assert out["prompts"][0]["trigger"] == ["x"]
    assert out["prompts"][0]["position"] == "fixed"

    assert out["utilityPrompts"]["newChatPrompt"] == "[Start a new Chat]"
    assert "new_chat_prompt" not in out["other"]
    assert out["other"]["temp"] == 1.2

    assert len(out["regexScripts"]) == 1
    assert out["regexScripts"][0]["name"] == "preset-regex"
    assert out["regexScripts"][0]["targets"] == ["slashCommands"]
    assert out["regexScripts"][0]["view"] == ["model"]
    assert out["regexScripts"][0]["macroMode"] == "raw"


def test_convert_character_and_history_from_silly_tavern_legacy_mapping():
    character = convert_character_from_silly_tavern(
        {
            "avatar": "Alice.png",
            "chat": "chat-1",
            "create_date": "2025-01-01T00:00:00.000Z",
            "data": {
                "name": "Alice",
                "description": "desc",
                "first_mes": "Hi",
                "alternate_greetings": ["Yo"],
                "character_book": {
                    "name": "AliceBook",
                    "entries": [
                        {
                            "id": 10,
                            "comment": "KB",
                            "content": "knowledge",
                            "enabled": True,
                            "keys": ["alice"],
                            "secondary_keys": [],
                            "insertion_order": 2,
                            "extensions": {"position": 0},
                        }
                    ],
                },
                "extensions": {
                    "regex_scripts": [
                        {
                            "id": "char-r-1",
                            "scriptName": "char-regex",
                            "disabled": False,
                            "findRegex": "x",
                            "replaceString": "y",
                            "placement": [3],
                            "promptOnly": True,
                        }
                    ]
                },
            },
        }
    )

    assert character["name"] == "Alice"
    assert character["message"] == ["Hi", "Yo"]
    assert character["worldBook"]["name"] == "AliceBook"
    assert len(character["worldBook"]["entries"]) == 1
    assert len(character["regexScripts"]) == 1
    assert character["chatDate"] == "chat-1"

    history = convert_history_from_silly_tavern(
        [
            {"is_system": True, "mes": "SYS"},
            {"is_user": True, "mes": "U1", "swipe_id": 1, "swipes": ["U1-A", "U1-B"]},
            {"role": "assistant", "content": "A1"},
        ]
    )

    assert [x["role"] for x in history] == ["system", "user", "model"]
    assert history[1]["content"] == "U1"
    assert history[1]["swipeId"] == 1
    assert history[1]["swipes"] == ["U1-A", "U1-B"]


def test_convert_messages_in_out_openai_roundtrip():
    openai = [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "U"},
        {"role": "assistant", "content": "A"},
    ]

    conv = convert_messages_in(openai, "openai")
    assert [m["role"] for m in conv["internal"]] == ["system", "user", "model"]

    back = convert_messages_out(conv["internal"], "openai")
    assert isinstance(back, list)
    assert [m["role"] for m in back] == ["system", "user", "assistant"]


def test_build_prompt_from_silly_tavern_wrapper():
    result = build_prompt_from_silly_tavern(
        {
            "preset": {
                "name": "Legacy Wrapper Preset",
                "prompts": [
                    {
                        "identifier": "main",
                        "name": "Main",
                        "enabled": True,
                        "role": "system",
                        "content": "Hello {{user}} <X>",
                        "injection_depth": 0,
                        "injection_order": 0,
                        "injection_trigger": [],
                        "injection_position": 0,
                    },
                    {
                        "identifier": "chatHistory",
                        "name": "Chat History",
                        "enabled": True,
                        "role": "system",
                        "content": "",
                        "injection_depth": 0,
                        "injection_order": 0,
                        "injection_trigger": [],
                        "injection_position": 0,
                    },
                ],
                "prompt_order": [
                    {
                        "character_id": 100001,
                        "order": [{"identifier": "main", "enabled": True}, {"identifier": "chatHistory", "enabled": True}],
                    }
                ],
                "extensions": {
                    "regex_scripts": [
                        {
                            "id": "legacy-rx",
                            "scriptName": "legacy-rx",
                            "disabled": False,
                            "findRegex": "<X>",
                            "replaceString": "Z",
                            "trimStrings": [],
                            "placement": [3],
                            "markdownOnly": False,
                            "promptOnly": True,
                            "runOnEdit": False,
                            "substituteRegex": 0,
                            "minDepth": None,
                            "maxDepth": None,
                        }
                    ]
                },
            },
            "globals": {
                "worldBooks": [
                    {
                        "name": "LegacyWB",
                        "entries": {1: {"uid": 1, "comment": "Legacy Fixed", "content": "WBX", "constant": True, "position": 4, "role": 0}},
                    }
                ]
            },
            "history": [{"is_user": True, "mes": "Hi"}],
            "view": "model",
            "macros": {"user": "Bob"},
            "outputFormat": "tagged",
        }
    )

    main = find_tagged_by_tag(result["stages"]["tagged"]["afterPostRegex"], "Preset: Main")
    assert main["text"] == "Hello Bob Z"
    wb = find_tagged_by_tag(result["stages"]["tagged"]["afterPostRegex"], "Worldbook: Legacy Fixed")
    assert wb["text"] == "WBX"


def test_build_prompt_4_stages_and_pipeline_changes():
    preset = make_preset()

    result = build_prompt(
        preset=preset,
        globals={"worldBooks": make_worldbooks_multi_file(), "regexScripts": make_regexes_multi_file()},
        history=History.openai(
            [
                {"role": "system", "content": "System history message"},
                {"role": "user", "content": "trigger: hello"},
                {"role": "assistant", "content": "OK"},
            ]
        ),
        view="model",
        macros={"user": "Bob", "char": "Alice"},
        output_format="openai",
        system_role_policy="keep",
    )

    assert_has_stages(result["stages"]["tagged"], "stages.tagged")
    assert_has_stages(result["stages"]["internal"], "stages.internal")
    assert_has_stages(result["stages"]["output"], "stages.output")

    raw_text_all = "\n".join(x["text"] for x in result["stages"]["tagged"]["raw"])
    assert "WB_COND" in raw_text_all

    raw_main = find_tagged_by_tag(result["stages"]["tagged"]["raw"], "Preset: Main")
    pre_main = find_tagged_by_tag(result["stages"]["tagged"]["afterPreRegex"], "Preset: Main")
    macro_main = find_tagged_by_tag(result["stages"]["tagged"]["afterMacro"], "Preset: Main")
    post_main = find_tagged_by_tag(result["stages"]["tagged"]["afterPostRegex"], "Preset: Main")

    assert raw_main["text"] == "Hello {{user}} <X>"
    assert pre_main["text"] == "Hello {{user}} <X>"
    assert macro_main["text"] == "Hello Bob <X>"
    assert post_main["text"] == "Hello Bob Z"

    per = None
    for x in result["stages"]["perItem"]:
        if "Preset: Main" in str(x.get("tag")):
            per = x
            break
    assert per is not None
    assert per["raw"] == "Hello {{user}} <X>"
    assert per["afterPreRegex"] == "Hello {{user}} <X>"
    assert per["afterMacro"] == "Hello Bob <X>"
    assert per["afterPostRegex"] == "Hello Bob Z"

    idx_wb = next(i for i, x in enumerate(result["stages"]["tagged"]["raw"]) if x["text"] == "WB_BEFORE")
    idx_char_before = next(
        i for i, x in enumerate(result["stages"]["tagged"]["raw"]) if "Preset: Char Before" in x["tag"]
    )
    assert idx_wb < idx_char_before


def test_build_prompt_depth_injection():
    preset = make_preset()
    result = build_prompt(
        preset=preset,
        globals={"worldBooks": [], "regexScripts": []},
        history=History.openai([{"role": "user", "content": "m1"}, {"role": "assistant", "content": "m2"}, {"role": "user", "content": "m3"}]),
        view="model",
        macros={"user": "Bob", "char": "Alice"},
        output_format="tagged",
    )

    lst = result["stages"]["tagged"]["raw"]
    idx_h1 = next(i for i, x in enumerate(lst) if x["tag"] == "History: user" and x["text"] == "m1")
    idx_h2 = next(i for i, x in enumerate(lst) if x["tag"] == "History: model" and x["text"] == "m2")
    idx_h3 = next(i for i, x in enumerate(lst) if x["tag"] == "History: user" and x["text"] == "m3")
    idx_inj = next(i for i, x in enumerate(lst) if x["tag"] == "Preset: Inject")

    assert idx_h2 < idx_inj < idx_h3
    assert idx_h1 < idx_h2


def test_build_prompt_worldbook_order_before_char():
    preset = make_preset()
    result = build_prompt(
        preset=preset,
        globals={"worldBooks": make_worldbooks_for_order_test(), "regexScripts": []},
        history=History.text("hi"),
        view="model",
        macros={"user": "Bob", "char": "Alice"},
        output_format="tagged",
    )

    raw = result["stages"]["tagged"]["raw"]
    idx1 = next(i for i, x in enumerate(raw) if x["text"] == "WB_ORDER_1")
    idx2 = next(i for i, x in enumerate(raw) if x["text"] == "WB_ORDER_2")
    idx_char_before = next(i for i, x in enumerate(raw) if "Preset: Char Before" in x["tag"])
    assert idx1 < idx2 < idx_char_before


def test_build_prompt_fixed_injection_depth_order_mixed():
    preset = make_preset_for_depth_order_test()
    result = build_prompt(
        preset=preset,
        globals={"worldBooks": make_worldbooks_for_depth_order_injections(), "regexScripts": []},
        history=History.openai([{"role": "user", "content": "m1"}, {"role": "assistant", "content": "m2"}, {"role": "user", "content": "m3"}, {"role": "assistant", "content": "m4"}]),
        view="model",
        macros={"user": "Bob", "char": "Alice"},
        output_format="tagged",
    )

    raw = result["stages"]["tagged"]["raw"]
    raw_texts = [x["text"] for x in raw]

    assert "W_FIXED_NO_DEPTH_SHOULD_NOT_APPEAR" not in raw_texts
    assert "W_FIXED_NO_ORDER_SHOULD_NOT_APPEAR" not in raw_texts
    assert "W_BEFORE_CHAR_WITH_DEPTH" not in raw_texts  # no charBefore slot in this preset

    injections = [
        {"depth": 1, "order": 0, "text": "W_D1_O0"},
        {"depth": 2, "order": 1, "text": "W_D2_O1"},
        {"depth": 2, "order": 2, "text": "W_D2_O2"},
        {"depth": 1, "order": 5, "text": "P_D1_O5"},
        {"depth": 1, "order": 10, "text": "P_D1_O10"},
        {"depth": 2, "order": 0, "text": "P_D2_O0"},
    ]
    injections.sort(key=lambda x: (x["depth"], -x["order"]))
    expected_chat_history = simulate_depth_insert(["m1", "m2", "m3", "m4"], injections)

    start = raw_texts.index("m1")
    chat_history_slice = raw_texts[start:]
    assert "P_MISSING_ORDER_SHOULD_NOT_APPEAR" not in chat_history_slice
    assert chat_history_slice == expected_chat_history


def test_system_role_policy_to_user_openai_has_no_system():
    preset = make_preset()
    result = build_prompt(
        preset=preset,
        globals={"worldBooks": [], "regexScripts": []},
        history=History.openai([{"role": "system", "content": "SYS"}, {"role": "user", "content": "U"}, {"role": "assistant", "content": "A"}]),
        view="model",
        macros={"user": "Bob", "char": "Alice"},
        output_format="openai",
        system_role_policy="to_user",
    )

    out = result["stages"]["output"]["afterPostRegex"]
    assert isinstance(out, list)
    assert all(m["role"] != "system" for m in out)


def test_view_filter_global_regex_user_only():
    preset = make_preset()
    globals_ = {"worldBooks": [], "regexScripts": make_regexes_multi_file()}

    r_model = build_prompt(
        preset=preset,
        globals=globals_,
        history=History.text("hi"),
        view="model",
        macros={"user": "Bob", "char": "Alice"},
        output_format="tagged",
    )
    model_stage = find_tagged_by_tag(r_model["stages"]["tagged"]["afterPostRegex"], "Preset: Main")
    assert model_stage["text"] == "Hello Bob Z"

    r_user = build_prompt(
        preset=preset,
        globals=globals_,
        history=History.text("hi"),
        view="user",
        macros={"user": "Bob", "char": "Alice"},
        output_format="tagged",
    )
    user_stage = find_tagged_by_tag(r_user["stages"]["tagged"]["afterPostRegex"], "Preset: Main")
    assert ("USER_VIEW_REPLACED" in user_stage["text"]) or ("Bob" not in user_stage["text"])


def test_trim_and_match_replacement():
    preset = make_preset()
    globals_ = {
        "worldBooks": [],
        "regexScripts": [
            {
                "id": "trim-match",
                "name": "trim-match",
                "enabled": True,
                "findRegex": "apple",
                "replaceRegex": "**{{match}}**",
                "trimRegex": ["le"],
                "targets": ["slashCommands"],
                "view": ["model"],
                "runOnEdit": False,
                "macroMode": "none",
                "minDepth": None,
                "maxDepth": None,
            }
        ],
    }

    preset2 = {**preset, "prompts": [({**p, "content": "I like apple"} if p["identifier"] == "main" else p) for p in preset["prompts"]]}
    result = build_prompt(
        preset=preset2,
        globals=globals_,
        history=History.text("hi"),
        view="model",
        macros={"user": "Bob", "char": "Alice"},
        output_format="tagged",
    )
    main = find_tagged_by_tag(result["stages"]["tagged"]["afterPostRegex"], "Preset: Main")
    assert main["text"] == "I like **app**"


def test_macro_mode_escaped_find_regex():
    preset = make_preset()
    globals_ = {
        "worldBooks": [],
        "regexScripts": [
            {
                "id": "escape-find",
                "name": "escape-find",
                "enabled": True,
                "findRegex": "{{user}}",
                "replaceRegex": "U",
                "trimRegex": [],
                "targets": ["slashCommands"],
                "view": ["model"],
                "runOnEdit": False,
                "macroMode": "escaped",
                "minDepth": None,
                "maxDepth": None,
            }
        ],
    }
    preset2 = {**preset, "prompts": [({**p, "content": "Hello a.b"} if p["identifier"] == "main" else p) for p in preset["prompts"]]}
    result = build_prompt(
        preset=preset2,
        globals=globals_,
        history=History.text("hi"),
        view="model",
        macros={"user": "a.b"},
        output_format="tagged",
    )
    main = find_tagged_by_tag(result["stages"]["tagged"]["afterPostRegex"], "Preset: Main")
    assert main["text"] == "Hello U"


def test_variables_any_getvar_stringify_number_and_object():
    preset = make_preset()
    preset2 = {**preset, "prompts": [({**p, "content": "S={{getvar::score}} C={{getvar::cfg}}"} if p["identifier"] == "main" else p) for p in preset["prompts"]]}
    result = build_prompt(
        preset=preset2,
        globals={"worldBooks": [], "regexScripts": []},
        history=History.text("hi"),
        view="model",
        macros={"user": "Bob"},
        variables={"score": 100, "cfg": {"a": 1}},
        output_format="tagged",
    )

    main = find_tagged_by_tag(result["stages"]["tagged"]["afterMacro"], "Preset: Main")
    assert main["text"] == 'S=100 C={"a":1}'
    assert result["variables"]["local"]["score"] == 100
    assert result["variables"]["local"]["cfg"] == {"a": 1}


def test_variables_any_setvar_affects_following_getvar():
    preset = make_preset()
    preset2 = {**preset, "prompts": [({**p, "content": "{{setvar::foo::bar}}X{{getvar::foo}}"} if p["identifier"] == "main" else p) for p in preset["prompts"]]}
    result = build_prompt(
        preset=preset2,
        globals={"worldBooks": [], "regexScripts": []},
        history=History.text("hi"),
        view="model",
        output_format="tagged",
    )
    main = find_tagged_by_tag(result["stages"]["tagged"]["afterMacro"], "Preset: Main")
    assert main["text"] == "Xbar"
    assert result["variables"]["local"]["foo"] == "bar"


def test_variables_api_wrapper_semantics():
    ctx = create_variable_context({"a": 1, "s": "hi"}, {"g": 10})

    Variables.add(ctx, {"name": "a", "value": 2})
    assert ctx["local"]["a"] == 3

    Variables.add(ctx, {"name": "s", "value": "!"})
    assert ctx["local"]["s"] == "hi!"

    Variables.inc(ctx, {"name": "a"})
    assert ctx["local"]["a"] == 4

    Variables.dec(ctx, {"name": "a"})
    assert ctx["local"]["a"] == 3

    Variables.set(ctx, {"name": "g", "value": 20, "scope": "global"})
    assert ctx["global"]["g"] == 20

    got = Variables.get(ctx, {"name": "g", "scope": "global"})
    assert got["value"] == 20

    listed = Variables.list(ctx, {"scope": "local"})
    assert listed["variables"]["a"] == 3

    Variables.delete(ctx, {"name": "a"})
    assert "a" not in ctx["local"]

