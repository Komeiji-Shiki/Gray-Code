from __future__ import annotations

from .detect import MessageFormat, MessageInput, detect_message_format
from .gemini import from_internal_to_gemini, is_gemini_messages, to_internal_from_gemini
from .openai import from_internal_to_openai, is_openai_chat_messages, to_internal_from_openai
from .tagged import from_internal_to_tagged, is_tagged_contents, to_internal_from_tagged
from .text import from_internal_to_text, is_text_input, to_internal_from_text

# TS-style aliases (camelCase)
detectMessageFormat = detect_message_format

