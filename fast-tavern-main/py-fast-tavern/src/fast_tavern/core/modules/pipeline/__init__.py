from __future__ import annotations

from .compile_tagged_stages import compile_tagged_stages
from .process_content_stages import process_content_stages

# TS-style aliases
compileTaggedStages = compile_tagged_stages
processContentStages = process_content_stages

__all__ = [
    "compile_tagged_stages",
    "process_content_stages",
    "compileTaggedStages",
    "processContentStages",
]

