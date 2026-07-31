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
        # 对齐 TS String(text ?? '')：0/False 不是空值，只有 None 才转空串
        joined = "\n".join(text) if isinstance(text, list) else ("" if text is None else str(text))
        return [{"role": "user", "parts": [{"text": joined}]}]

