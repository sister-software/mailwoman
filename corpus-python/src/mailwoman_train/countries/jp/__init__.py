"""Japan. Corpus from Overture-JP; registers from KEN_ALL and the national corporate register."""

from __future__ import annotations

from .corpora import BOARD_BUCKET_MIN, LABEL_SET_NAME
from .corpora import build as build_corpus

COUNTRY_CODE = "jp"

__all__ = ["BOARD_BUCKET_MIN", "COUNTRY_CODE", "LABEL_SET_NAME", "build_corpus"]
