from __future__ import annotations

# Public re-exports (align with TS `src/index.ts`)

from .core.types import *  # noqa: F401,F403
from .core.convert import convert_messages_in, convert_messages_out, detect_message_format, is_text_input
from .core.modules.assemble import assemble_tagged_prompt_list
from .core.modules.build import build_prompt, build_prompt_from_silly_tavern
from .core.modules.history import History
from .core.modules.inputs import (
    convert_character_from_silly_tavern,
    convert_history_from_silly_tavern,
    convert_history_message_from_silly_tavern,
    convert_preset_from_silly_tavern,
    convert_regex_from_silly_tavern,
    convert_regexes_from_silly_tavern,
    convert_worldbook_entry_from_silly_tavern,
    convert_worldbook_from_silly_tavern,
    convert_worldbooks_from_silly_tavern,
    normalize_regexes,
    normalize_worldbooks,
)
from .core.modules.macro import replace_macros
from .core.modules.pipeline import compile_tagged_stages, process_content_stages
from .core.modules.regex import apply_regex, merge_regex_rules
from .core.modules.variables import (
    Variables,
    create_variable_context,
    get_global_var,
    get_var,
    get_variable_changes,
    process_variable_macros,
    set_global_var,
    set_var,
)
from .core.modules.worldbook import get_active_entries

# TS-style aliases (camelCase)
buildPrompt = build_prompt
buildPromptFromSillyTavern = build_prompt_from_silly_tavern
convertMessagesIn = convert_messages_in
convertMessagesOut = convert_messages_out
detectMessageFormat = detect_message_format
isTextInput = is_text_input
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
getActiveEntries = get_active_entries
assembleTaggedPromptList = assemble_tagged_prompt_list
replaceMacros = replace_macros
applyRegex = apply_regex
mergeRegexRules = merge_regex_rules
createVariableContext = create_variable_context

# Channels namespace-like export (TS: export * as Channels)
from .core import channels as Channels  # noqa: E402
