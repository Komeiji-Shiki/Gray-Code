from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict, Union

# =========================
# Core scalar types
# =========================

Role = Literal["system", "user", "model"]

VariableScope = Literal["local", "global"]

RegexTarget = Literal["userInput", "aiOutput", "slashCommands", "worldBook", "reasoning"]
RegexView = Literal["user", "model"]
RegexMacroMode = Literal["none", "raw", "escaped"]

OutputFormat = Literal["gemini", "openai", "tagged", "text"]


# =========================
# Regex (align with TS RegexScriptData)
# =========================

class RegexScriptData(TypedDict):
    id: str
    name: str
    enabled: bool
    findRegex: str
    replaceRegex: str
    trimRegex: list[str]
    targets: list[RegexTarget]
    view: list[RegexView]
    runOnEdit: bool
    macroMode: RegexMacroMode
    minDepth: int | None
    maxDepth: int | None


RegexScriptsFileInput = Union[
    list[RegexScriptData],
    dict[str, Any],  # { regexScripts: [...] } | { scripts: [...] } | single RegexScriptData
    RegexScriptData,
]
RegexScriptsInput = Union[RegexScriptsFileInput, list[RegexScriptsFileInput]]


# =========================
# Worldbook (align with TS WorldBookEntry / WorldBook)
# =========================

WorldBookEntryPosition = str
WorldBookEntryRole = Role
WorldBookEntrySelectiveLogic = Literal["andAny", "andAll", "notAll", "notAny"]
WorldBookEntryActivationMode = Literal["always", "keyword", "vector"]


class WorldBookEntry(TypedDict):
    index: int
    name: str
    content: str
    enabled: bool
    activationMode: WorldBookEntryActivationMode
    key: list[str]
    secondaryKey: list[str]
    selectiveLogic: WorldBookEntrySelectiveLogic
    order: int
    depth: int
    position: WorldBookEntryPosition
    role: WorldBookEntryRole | None
    caseSensitive: bool | None
    excludeRecursion: bool
    preventRecursion: bool
    probability: int
    other: dict[str, Any]


class WorldBook(TypedDict):
    name: str
    entries: list[WorldBookEntry]


WorldBookInput = Union[
    WorldBook,
    list[WorldBookEntry],
    dict[str, Any],  # { entries: [...], enabled?: bool, name?: str }
]
WorldBooksInput = Union[WorldBookInput, list[WorldBookInput]]


# =========================
# Preset / Character (align with TS PromptInfo / PresetInfo / CharacterCard)
# =========================


class UtilityPrompts(TypedDict, total=False):
    impersonationPrompt: NotRequired[str]
    worldInfoFormat: NotRequired[str]
    scenarioFormat: NotRequired[str]
    personalityFormat: NotRequired[str]
    groupNudgePrompt: NotRequired[str]
    newChatPrompt: NotRequired[str]
    newGroupChatPrompt: NotRequired[str]
    newExampleChatPrompt: NotRequired[str]
    continueNudgePrompt: NotRequired[str]
    sendIfEmpty: NotRequired[str]
    seed: NotRequired[int]




class PromptInfo(TypedDict, total=False):
    identifier: str
    name: str
    enabled: bool
    index: NotRequired[int]
    role: str
    content: str
    depth: int
    order: int
    trigger: list[Any]
    position: Literal["relative", "fixed"]


class PresetInfo(TypedDict, total=False):
    name: str
    prompts: list[PromptInfo]
    regexScripts: list[RegexScriptData]
    utilityPrompts: UtilityPrompts
    other: Any
    # deprecated: kept for input compatibility
    apiSetting: NotRequired[Any]




class CharacterCard(TypedDict):
    name: str
    description: str
    avatar: str
    message: list[str]
    worldBook: WorldBook | None
    regexScripts: list[RegexScriptData]
    other: dict[str, Any]
    chatDate: str
    createDate: str


# =========================
# History (ChatMessage / MessagePart)
# =========================


class MessagePartText(TypedDict):
    text: str


class MessagePartInlineData(TypedDict):
    inlineData: dict[str, str]  # { mimeType, data }


class MessagePartFileData(TypedDict):
    fileData: dict[str, str]  # { mimeType, fileUri }


MessagePart = Union[MessagePartText, MessagePartInlineData, MessagePartFileData]


class ChatMessageBase(TypedDict, total=False):
    role: str
    name: NotRequired[str]
    swipeId: NotRequired[int]


class ChatMessageGemini(ChatMessageBase):
    parts: list[MessagePart]
    swipes: NotRequired[list[list[MessagePart]]]


class ChatMessageOpenAI(ChatMessageBase):
    content: str
    swipes: NotRequired[list[str]]


ChatMessage = Union[ChatMessageGemini, ChatMessageOpenAI]


# =========================
# Engine debug structures
# =========================


class TaggedContent(TypedDict, total=False):
    tag: str
    role: Role
    text: str
    target: RegexTarget
    historyDepth: NotRequired[int]


class PromptStages(TypedDict):
    raw: Any
    afterPreRegex: Any
    afterMacro: Any
    afterPostRegex: Any


class PerItemStages(TypedDict, total=False):
    tag: str
    role: Role
    target: RegexTarget
    historyDepth: NotRequired[int]
    raw: str
    afterPreRegex: str
    afterMacro: str
    afterPostRegex: str


class BuildPromptParams(TypedDict, total=False):
    preset: PresetInfo
    character: NotRequired[CharacterCard]
    globals: NotRequired[dict[str, Any]]  # { worldBooks?, regexScripts? }
    history: list[ChatMessage]
    view: RegexView
    outputFormat: NotRequired[OutputFormat]
    systemRolePolicy: NotRequired[Literal["keep", "to_user"]]
    macros: NotRequired[dict[str, str]]
    variables: NotRequired[dict[str, Any]]
    globalVariables: NotRequired[dict[str, Any]]
    options: NotRequired[dict[str, Any]]

class BuildPromptFromSillyTavernParams(TypedDict, total=False):
    preset: Any
    character: NotRequired[Any]
    globals: NotRequired[dict[str, Any]]  # { worldBooks?, regexScripts? }
    history: list[Any]
    view: RegexView
    outputFormat: NotRequired[OutputFormat]
    systemRolePolicy: NotRequired[Literal["keep", "to_user"]]
    macros: NotRequired[dict[str, str]]
    variables: NotRequired[dict[str, Any]]
    globalVariables: NotRequired[dict[str, Any]]
    options: NotRequired[dict[str, Any]]



class BuildPromptResult(TypedDict):
    outputFormat: OutputFormat
    systemRolePolicy: Literal["keep", "to_user"]
    activeWorldbookEntries: list[WorldBookEntry]
    mergedRegexScripts: list[RegexScriptData]
    variables: dict[str, dict[str, Any]]  # { local, global }
    stages: dict[str, Any]  # tagged/internal/output/perItem

