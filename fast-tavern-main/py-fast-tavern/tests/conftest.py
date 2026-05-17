from __future__ import annotations

import sys
from pathlib import Path


# Allow running pytest without installing the package (src-layout).
SRC = (Path(__file__).resolve().parents[1] / "src").as_posix()
if SRC not in sys.path:
    sys.path.insert(0, SRC)

