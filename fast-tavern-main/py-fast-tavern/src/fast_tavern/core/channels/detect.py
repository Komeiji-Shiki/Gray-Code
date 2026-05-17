from __future__ import annotations

from typing import Any, Literal, TypeAlias

from ..types import ChatMessage, TaggedContent
from .gemini import is_gemini_messages
from .openai import is_openai_chat_messages
from .tagged import is_tagged_contents
from .text import is_text_input

MessageFormat = Literal["auto", "gemini", "openai", "tagged", "text"]
MessageInput: TypeAlias = list[ChatMessage] | list[TaggedContent] | str | list[str]


def detect_message_format(input_value: MessageInput) -> Literal["gemini", "openai", "tagged", "text"]:
    if is_text_input(input_value):
        return "text"
    if is_tagged_contents(input_value):
        return "tagged"
    if is_gemini_messages(input_value):
        return "gemini"
    if is_openai_chat_messages(input_value):
        return "openai"
    return "gemini"

