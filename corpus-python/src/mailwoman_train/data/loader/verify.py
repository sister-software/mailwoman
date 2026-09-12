"""The corpus/tokenizer compatibility check a run makes before it starts."""

from __future__ import annotations

from pathlib import Path

import pyarrow.parquet as pq

from ...tokenizer import Tokenizer, whitespace_spans
from .corpus_files import _slice_paths
from .parquet import _REQUIRED_COLUMNS


def verify_tokenizer_alignment(
    corpus_dir: Path,
    tokenizer: Tokenizer,
    *,
    sample_size: int = 100,
) -> None:
    """Assert that the SP tokenizer is *compatible* with the stored whitespace tokens.

    The stored ``tokens`` field is whitespace-tokenized, while the model uses SentencePiece
    sub-tokens. They will not be byte-identical. What we DO need is:

    1. The whitespace tokens are recoverable from ``raw`` via left-to-right substring scan
       (corpus invariant — if this breaks, the corpus build is corrupt).
    2. The SP tokenizer can be loaded.

    If invariant (1) fails this raises; (2) failed earlier when we constructed Tokenizer.
    """
    slice = _slice_paths(corpus_dir, "train")[0]
    pf = pq.ParquetFile(slice)
    t = pf.read_row_group(0, columns=list(_REQUIRED_COLUMNS))
    raws = t["raw"]
    tokens_col = t["tokens"]
    n = min(sample_size, t.num_rows)
    for i in range(n):
        raw = raws[i].as_py()
        toks = tokens_col[i].as_py()
        try:
            whitespace_spans(raw, toks)
        except ValueError as exc:
            raise RuntimeError(f"corpus tokenizer invariant broken at row {i} of slice {slice}: {exc}") from exc
        # Smoke the SP encoder so a mis-pointed tokenizer.model fails fast.
        tokenizer.encode_with_spans(raw)
