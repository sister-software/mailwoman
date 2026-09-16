"""Score a JP char checkpoint on the municipality-held-out board.

The evaluator argmax-decodes character BIO labels, reconstructs spans, resolves the selected admin
pair against municipality centroids, and grades coordinate acceptability. It reports per-register
diagnostics when the board provides a ``register`` column; ``--label-set`` selects matching labels
and resolve tags.
"""

from __future__ import annotations

from .cli import CTX, MAX_UNITS, PROBE_DIR_PARTS, WIDTH, format_report, main, parse_args, probe_dir, resolve_tags_for
from .decode import decode_all_spans, decode_runs, decode_spans, haversine_km, norm_key
from .score import ACCEPT_KM, CHECK, RESOLVE_TAGS, BoardTallies, RowOutcome, score_board, score_row

__all__ = [
    "ACCEPT_KM",
    "CHECK",
    "CTX",
    "MAX_UNITS",
    "PROBE_DIR_PARTS",
    "RESOLVE_TAGS",
    "WIDTH",
    "BoardTallies",
    "RowOutcome",
    "decode_all_spans",
    "decode_runs",
    "decode_spans",
    "format_report",
    "haversine_km",
    "main",
    "norm_key",
    "parse_args",
    "probe_dir",
    "resolve_tags_for",
    "score_board",
    "score_row",
]
