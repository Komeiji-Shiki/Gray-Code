from __future__ import annotations

from .build_prompt import build_prompt
from .build_prompt_from_silly_tavern import build_prompt_from_silly_tavern

# TS-style aliases
buildPrompt = build_prompt
buildPromptFromSillyTavern = build_prompt_from_silly_tavern

__all__ = [
    "build_prompt",
    "build_prompt_from_silly_tavern",
    "buildPrompt",
    "buildPromptFromSillyTavern",
]
