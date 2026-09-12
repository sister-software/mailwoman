"""Score a v8 JP char model on the municipality-held-out board (the pre-registered eval read).

PRE-REGISTERED DEFINITION — written before any board inference was run (the bars-are-bars rule):

- Inference: the trained char-mode checkpoint argmax-decodes per-char BIO over each board row's
  ``raw`` (same encode path as training: ``encode_row_units``, one unit per char, ctx 3 / W 7 /
  S 96, the sealed train-split char vocab). No CRF, no channels, no heals.
- Span reconstruction: contiguous ``B-``/``I-`` runs of the same tag over the char sequence; a
  row's predicted REGION and LOCALITY are the concatenated chars of the first such span per tag.
  The per-tag diagnostic keeps every run: a gold span hits when its exact surface was emitted under
  its tag anywhere in the row, so a ladder that repeats a tag (KR 읍/면 + 리) is readable.
- Resolve: predicted (region, locality) → the (pref|muni) centroid table built from the FULL
  Overture-JP parquet (mean point per municipality, 1,530 entries) via exact NFC/space-stripped
  kanji match. No fuzzy matching — a hallucinated or truncated name misses, and that is the point.
- **Coordinate-acceptability: haversine(resolved centroid, the row's gold point) <= 15 km.**
  A row whose predicted pair is absent from the table is UNACCEPTABLE. 15 km covers the areal
  spread of large municipalities around their own centroid (the WOF-JP point-geometry situation:
  municipality centroids suffice — the architecture plan's stated resolution).
- **EVAL (Leg 1, pre-registered 2026-07-18): acceptable fraction >= 0.70.**
- Secondary diagnostics reported alongside (the FAIL ladder's first rung, computed either way):
  per-tag span exact-match rates (region/locality/street/house_number/postcode vs the board's
  gold spans) and the unresolved-pair count.

--- Phase-3 additions (2026-08-05). The check above is UNCHANGED; both additions are diagnostic. ---

**Per-register acceptability.** The full JP slice (#1458) writes a ``register`` column on every
board row — which of the four surfaces the JP corpus builder rendered it in (``native`` /
``arabic_chome`` / ``compact_folded`` / ``designator``). One blended number cannot tell "the model
reads Japanese" from "the model reads the 68% of the board that is the source's own surface", and
the two synthesized registers are exactly the ones the source never contains — so they are the ones
a blended average hides. This script now splits the SAME per-row outcomes by that column and prints
the breakdown under the blended number. **The check is still the blended fraction >= 0.70**; a
per-register number has no bar attached to it and cannot pass or fail anything. Boards with no
``register`` column (the Leg-1 probe board) simply get no breakdown — the blended read is identical.

**Label-set / resolve-tag parameterization.** The Leg-1 board was STAGE3, where the JP admin ladder
was mapped prefecture → ``region`` and municipality → ``locality``. The Phase-3 board is
``stage3-jp``, where those are their own tags (``prefecture`` / ``municipality``) in a 47-label
head. Reading the module-global 33-label ``ID_TO_LABEL`` against a 47-label checkpoint would
mislabel silently (the #1349 lesson), so ``--label-set`` selects the vocabulary and the resolve tags
default from it. ``--label-set stage3`` reproduces the Leg-1 read exactly.

Three modules: `decode` reconstructs spans from a label sequence, `score` runs the read row by row,
`cli` prints it and drives a checkpoint. Only `cli` imports torch.

Usage:
  # Leg-1 probe board (unchanged behavior)
  python -m mailwoman_train.evaluation.jp_probe_board --checkpoint <dir-with-pytorch_model.bin>

  # Phase-3 full-slice board
  python -m mailwoman_train.evaluation.jp_probe_board --checkpoint <dir> --label-set stage3-jp \
      --board $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-full-2026-08-04/jp-board.jsonl \
      --vocab $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-full-2026-08-04/char-vocab-jp-full.json \
      --centroids $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-probe/jp-muni-centroids.json

  (The centroid table is keyed on raw kanji ``pref|muni`` and was built from the FULL Overture-JP
  parquet, so it is label-set independent and the probe-dir copy is the right one to reuse.)
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
