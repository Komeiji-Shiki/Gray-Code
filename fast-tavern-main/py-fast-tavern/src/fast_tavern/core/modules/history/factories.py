from __future__ import annotations

from ...types import ChatMessage


class History:
    """
    Helpers to create history (wrapper ChatMessage[]).

    Aligns with TS:
    - gemini: pass through `parts`-style messages
    - openai: pass through `content`-style messages
    - text: create a single user(parts) message
    """

    @staticmethod
    def gemini(messages: list[ChatMessage]) -> list[ChatMessage]:
        return messages

    @staticmethod
    def openai(messages: list[ChatMessage]) -> list[ChatMessage]:
        return messages

    @staticmethod
    def text(text: str | list[str]) -> list[ChatMessage]:
        joined = "\n".join(text) if isinstance(text, list) else str(text or "")
        return [{"role": "user", "parts": [{"text": joined}]}]

