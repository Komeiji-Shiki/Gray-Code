from __future__ import annotations

from .convert_from_silly_tavern import (
    convert_character_from_silly_tavern,
    convert_history_from_silly_tavern,
    convert_history_message_from_silly_tavern,
    convert_preset_from_silly_tavern,
    convert_regex_from_silly_tavern,
    convert_regexes_from_silly_tavern,
    convert_worldbook_entry_from_silly_tavern,
    convert_worldbook_from_silly_tavern,
    convert_worldbooks_from_silly_tavern,
)
from .normalize_regexes import normalize_regexes
from .normalize_worldbooks import normalize_worldbooks

# TS-style aliases
normalizeRegexes = normalize_regexes
normalizeWorldbooks = normalize_worldbooks
convertPresetFromSillyTavern = convert_preset_from_silly_tavern
convertWorldBookEntryFromSillyTavern = convert_worldbook_entry_from_silly_tavern
convertWorldBookFromSillyTavern = convert_worldbook_from_silly_tavern
convertWorldBooksFromSillyTavern = convert_worldbooks_from_silly_tavern
convertRegexFromSillyTavern = convert_regex_from_silly_tavern
convertRegexesFromSillyTavern = convert_regexes_from_silly_tavern
convertCharacterFromSillyTavern = convert_character_from_silly_tavern
convertHistoryMessageFromSillyTavern = convert_history_message_from_silly_tavern
convertHistoryFromSillyTavern = convert_history_from_silly_tavern

__all__ = [
    "normalize_regexes",
    "normalize_worldbooks",
    "convert_preset_from_silly_tavern",
    "convert_worldbook_entry_from_silly_tavern",
    "convert_worldbook_from_silly_tavern",
    "convert_worldbooks_from_silly_tavern",
    "convert_regex_from_silly_tavern",
    "convert_regexes_from_silly_tavern",
    "convert_character_from_silly_tavern",
    "convert_history_message_from_silly_tavern",
    "convert_history_from_silly_tavern",
    "normalizeRegexes",
    "normalizeWorldbooks",
    "convertPresetFromSillyTavern",
    "convertWorldBookEntryFromSillyTavern",
    "convertWorldBookFromSillyTavern",
    "convertWorldBooksFromSillyTavern",
    "convertRegexFromSillyTavern",
    "convertRegexesFromSillyTavern",
    "convertCharacterFromSillyTavern",
    "convertHistoryMessageFromSillyTavern",
    "convertHistoryFromSillyTavern",
]
