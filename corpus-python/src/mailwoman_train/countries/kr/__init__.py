"""Korea. Corpus from the Juso road-name address register; permits from the building register."""

from __future__ import annotations

from .corpora import BOARD_BUCKET_MIN, LABEL_SET_NAME
from .corpora import build as build_corpus

COUNTRY_CODE = "kr"

__all__ = ["BOARD_BUCKET_MIN", "COUNTRY_CODE", "LABEL_SET_NAME", "build_corpus"]
