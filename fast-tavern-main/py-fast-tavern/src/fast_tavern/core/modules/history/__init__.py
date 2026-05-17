from __future__ import annotations

from .factories import History
from .guards import is_chat_messages

# TS-style alias
isHistoryInput = is_chat_messages

__all__ = ["History", "is_chat_messages", "isHistoryInput"]

