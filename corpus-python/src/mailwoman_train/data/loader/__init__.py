"""Streaming parquet → encoded tensors data pipeline for Phase 2 training.

Reads ``corpus-v0.1.0`` parquet slices via PyArrow's row-group iterator (lazy, memory-stable),
filters / weights rows per the YAML config, encodes each row through the SentencePiece
tokenizer with realigned BIO labels, and yields PyTorch ``(input_ids, attention_mask, labels)``
tensors in a batched ``DataLoader``-compatible shape.

Why PyArrow + a generator and not ``datasets.load_dataset('parquet', streaming=True)``?

- ``datasets`` would work; the row-group iterator path here is fewer moving parts, gives us
  direct per-row column projection (we never materialize ``tokens`` for rows we drop), and
  keeps the train loop deterministic for a fixed seed without the HF dataset shuffle buffer
  semantics.
- The data loader is the hot path on a CPU-bound train run; ad-hoc streaming is fine.

Per Phase 2 §2:

- Lazy + streaming + memory-stable: row-group iteration, never reads a full slice.
- Stratified sampling: ``country_weights`` are renormalized probabilities; rows are accepted
  with probability proportional to their country's weight relative to the max.
- Length filter: rows whose SP tokenization exceeds ``max_length`` are dropped.
- Tokenizer alignment verification: re-tokenize a sample and assert the stored ``tokens``
  match (see ``verify_tokenizer_alignment``).

v0.5.0 char-offset labels (#519): slices whose schema carries
``span_starts``/``span_ends``/``span_tags`` stream the triple end-to-end — through the
augmentations (which re-target it; see ``augment.py``) and the #511 relabel pass (char
arithmetic; see ``relabel.py``) into ``encode_row``, which builds the per-char label array FROM
the spans. Frozen pre-v0.5.0 slices carry no span columns and ride the legacy token path. A
slice with a partial column set, or a null span value in a span-schema slice, is corrupt and
raises loudly — never a silent fallback.

The modules, in the order a row travels them:

- `corpus_files.py` — which parquet files a split has, and how many rows each source holds.
- `parquet.py` — reading rows out of one file, shuffled, with the per-row filters applied.
- `mixture.py` — sampling across sources so the observed mix matches `source_weights`.
- `stream.py` — the shuffle buffer, the train-only policy, and the augmentation step.
- `encode.py` — one row to one `EncodedExample`, through SentencePiece or the char path.
- `batch.py` — stacking examples into the batch the trainer feeds the model.
- `example.py` — what an encoded row carries.
- `anchors.py` — the postcode→anchor lookup reader.
- `verify.py` — the corpus/tokenizer compatibility check a run makes before it starts.

EVERY STAGE DRAWS FROM ONE `random.Random`. Slice order, row-group order, row order, the
country-acceptance test, the source multinomial, the shuffle buffer and each augmentation share
the caller's stream, so adding, dropping or reordering a draw anywhere reshuffles the corpus a
seeded run trains on. `tests/mailwoman_train/data/test_loader_split_parity.py` pins the emitted
sequence for exactly that reason.

The underscore names below are re-exported because the audits and the census read them through
`mailwoman_train.data.loader`, which is the import path every caller uses.
"""

from __future__ import annotations

from ...labels import IGNORE_INDEX
from .anchors import load_anchor_lookup
from .batch import collate, iter_batches
from .corpus_files import _LEGACY_SLICES_KEY as _LEGACY_SLICES_KEY
from .corpus_files import _slice_first_source as _slice_first_source
from .corpus_files import _slice_paths as _slice_paths
from .corpus_files import manifest_slices, source_row_counts
from .encode import iter_encoded
from .example import EncodedExample
from .mixture import _raw_row_stream as _raw_row_stream
from .stream import iter_rows
from .verify import verify_tokenizer_alignment

__all__ = [
    "EncodedExample",
    "IGNORE_INDEX",
    "collate",
    "iter_batches",
    "iter_encoded",
    "iter_rows",
    "load_anchor_lookup",
    "manifest_slices",
    "source_row_counts",
    "verify_tokenizer_alignment",
]
