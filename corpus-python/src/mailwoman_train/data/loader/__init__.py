"""Stream sampled corpus rows into encoded tensors for training.

The trainer's rows come from the Rust sampler in `packages/mtf/crates/mtf-sampler`, through `mailwoman_mtf.Sampler` and
`mailwoman_mtf.TrainingBatches`. It lists each split from its manifest, verifies every file's sha256, indexes the train
files by source, draws each row's source from the `source_weights` multinomial, mixes rows in a shuffle buffer, and
augments and relabels train rows. Every stage draws from one generator that reproduces CPython's `random.Random`, so the
rows equal the ones the Python sampler drew for the same seed; the encoder-parity records in
`docs/engineering/reference/training-row-encoder.mdx` verify that. The row encoder (`mailwoman_mtf.RowEncoder`) or the
char encoder (`mailwoman_mtf.CharEncoder`) encodes each batch.

The modules:

- `encode.py` — the sampler's configuration, the sampled rows, and the encoders' construction.
- `batch.py` — the batch the trainer feeds the model, and the endless training stream.
- `example.py` — the fields of an encoded row.
- `verify.py` — the corpus/tokenizer compatibility check a run makes before it starts.
- `corpus_files.py`, `parquet.py` and `mixture.py` — the Python reader the audits under `audits/` still call
  through `_raw_row_stream`, `admitted_batches` and `corpus_split_files`. They go when those audits move to
  TypeScript or onto the Rust sampler.

The underscore names below are re-exported because the audits and the census read them through
`mailwoman_train.data.loader`, which is the import path every caller uses.
"""

from __future__ import annotations

from ...labels import IGNORE_INDEX
from .batch import collate, iter_batches, iter_training_batches
from .corpus_files import (
    CorpusFile,
    RowFilter,
    admitted_batches,
    corpus_split_files,
    file_source_counts,
    manifest_files,
    source_row_counts,
)
from .corpus_files import _parquet_paths as _parquet_paths
from .encode import build_row_encoder, iter_encoded, iter_rows, iter_sampled_rows
from .example import EncodedExample
from .mixture import _raw_row_stream as _raw_row_stream
from .verify import verify_tokenizer_alignment

__all__ = [
    "EncodedExample",
    "IGNORE_INDEX",
    "CorpusFile",
    "RowFilter",
    "admitted_batches",
    "collate",
    "corpus_split_files",
    "file_source_counts",
    "build_row_encoder",
    "iter_batches",
    "iter_encoded",
    "iter_rows",
    "iter_sampled_rows",
    "iter_training_batches",
    "manifest_files",
    "source_row_counts",
    "verify_tokenizer_alignment",
]
