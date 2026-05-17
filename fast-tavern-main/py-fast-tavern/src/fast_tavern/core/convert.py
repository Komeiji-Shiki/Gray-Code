from __future__ import annotations

from typing import Literal, TypedDict

from .channels.detect import MessageFormat, MessageInput, detect_message_format
from .channels.gemini import from_internal_to_gemini, to_internal_from_gemini
from .channels.openai import from_internal_to_openai, to_internal_from_openai
from .channels.tagged import to_internal_from_tagged
from .channels.text import from_internal_to_text, is_text_input, to_internal_from_text
from .types import ChatMessage, TaggedContent


class ConvertInResult(TypedDict):
    detected: Literal["gemini", "openai", "tagged", "text"]
    internal: list[ChatMessage]


def convert_messages_in(input_value: MessageInput, format: MessageFormat = "auto") -> ConvertInResult:
    detected: Literal["gemini", "openai", "tagged", "text"]
    detected = detect_message_format(input_value) if format == "auto" else format  # type: ignore[assignment]

    if detected == "text":
        return {"detected": detected, "internal": to_internal_from_text(input_value)}  # type: ignore[arg-type]
    if detected == "gemini":
        return {"detected": detected, "internal": to_internal_from_gemini(input_value)}  # type: ignore[arg-type]
    if detected == "openai":
        return {"detected": detected, "internal": to_internal_from_openai(input_value)}  # type: ignore[arg-type]
    if detected == "tagged":
        return {"detected": detected, "internal": to_internal_from_tagged(input_value)}  # type: ignore[arg-type]

    return {"detected": "gemini", "internal": to_internal_from_gemini(input_value)}  # type: ignore[arg-type]


def convert_messages_out(
    internal: list[ChatMessage], format: Literal["gemini", "openai", "tagged", "text"]
) -> list[ChatMessage] | list[TaggedContent] | str:
    if format == "gemini":
        return from_internal_to_gemini(internal)
    if format == "openai":
        return from_internal_to_openai(internal)
    if format == "text":
        return from_internal_to_text(internal)

    # tagged cannot be reconstructed from internal (same as TS behavior)
    return internal


__all__ = ["detect_message_format", "MessageFormat", "MessageInput", "convert_messages_in", "convert_messages_out", "is_text_input"]

