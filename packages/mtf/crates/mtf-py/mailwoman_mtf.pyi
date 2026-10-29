"""Type stubs for the `mailwoman_mtf` extension built from `packages/mtf/crates/mtf-py`."""

from typing import Any, Final

import numpy as np
import numpy.typing as npt

UNICODE_VERSION: Final[str]
CHANNEL_NAMES: Final[list[str]]
CODE_UNIT_FEATURE_DIM: Final[int]

class Tokenizer:
    """A SentencePiece unigram model loaded by `mtf-core`."""

    def __init__(self, model: bytes) -> None: ...
    @property
    def vocab_size(self) -> int: ...
    @property
    def pad_id(self) -> int: ...
    @property
    def unk_id(self) -> int: ...
    @property
    def bos_id(self) -> int: ...
    @property
    def eos_id(self) -> int: ...
    def encode(self, raw: str) -> list[tuple[int, str, int, int]]:
        """Each piece of `raw` as `(id, piece, char_begin, char_end)` in code points."""
    def id_to_piece(self, id: int) -> str: ...
    def piece_to_id(self, piece: str) -> int: ...

class RowEncoder:
    """A run's row encoder: the tokenizer, the label table, the lexicons and the span finders."""

    def __init__(
        self,
        tokenizer: Tokenizer | None,
        *,
        max_length: int,
        label_to_id: dict[str, int],
        active_tags: list[str],
        ignore_index: int,
        locale_countries: list[str],
        postcode_shapes_path: str,
        postcode_syntax_path: str,
        pad_id: int | None = None,
        anchor_lookup_path: str | None = None,
        anchor_paint_mode: str = "gold",
        gazetteer_lexicon_path: str | None = None,
        gazetteer_choreography: bool = False,
        country_lexicon_path: str | None = None,
        street_type_lexicon_path: str | None = None,
        locality_surface_lexicon_path: str | None = None,
        code_units: bool = False,
    ) -> None: ...
    @property
    def channel_dims(self) -> list[tuple[str, int]]: ...
    def encode_batch(
        self, rows: list[dict[str, Any]], pieces: list[list[tuple[int, int, int]]] | None = None
    ) -> dict[str, npt.NDArray[np.int64] | npt.NDArray[np.float32]]:
        """The batch's arrays: `[B, L]` int64 ids, mask and labels; per channel `[B, L, D]` and `[B, L]` float32."""
    def shaped_postcode_spans(self, raw: str) -> list[tuple[int, int]]: ...

class PostcodeShapes:
    """The postcode-shape record compiled with Python's `re` semantics."""

    def __init__(self, path: str) -> None: ...
    @property
    def labels(self) -> list[str]: ...
    def collect_matches(self, text: str) -> list[tuple[int, int, str, int]]: ...

class PostcodeSyntax:
    """Each country's postcode syntax, compiled case-insensitively."""

    def __init__(self, path: str) -> None: ...
    def accepting(self, value: str) -> int: ...

def segment_code_units(text: str) -> list[tuple[int, int]]: ...

class Sampler:
    """One split's sampled rows from `mtf-sampler`, each a dict with `raw`, `tokens`, `labels`, `country`, `source`
    and, when its file stores one, the span triple."""

    def __init__(self, config: str, split: str, seed: int, row_limit: int | None = None) -> None: ...
    def __iter__(self) -> Sampler: ...
    def __next__(self) -> dict[str, Any]: ...
    def next_rows(self, count: int) -> list[dict[str, Any]]:
        """The next `count` rows, fewer at exhaustion, and an empty list once no row remains."""
    def cancel(self) -> None: ...
    @property
    def yielded(self) -> int: ...
    @property
    def astral_skipped(self) -> int: ...
    @property
    def postcode_move_outcomes(self) -> list[tuple[str, int]]: ...

class TrainingBatches:
    """The train split's batches without end, reopened with `seed + epoch` for epochs 1, 2, …."""

    def __init__(
        self, config: str, *, batch_size: int, seed: int, row_limit: int | None = None, skip_batches: int = 0
    ) -> None: ...
    def __iter__(self) -> TrainingBatches: ...
    def __next__(self) -> list[dict[str, Any]]: ...
    @property
    def epoch(self) -> int: ...
    def cancel(self) -> None: ...

class CharEncoder:
    """The character path's encoder: per-unit character windows for the CharCNN front end."""

    def __init__(
        self,
        *,
        mode: str,
        vocab_path: str,
        max_units: int,
        max_unit_width: int,
        char_ctx: int,
        label_set: str,
        tags: list[str],
        bio_labels: list[str],
        ignore_index: int,
    ) -> None: ...
    def encode_batch(self, rows: list[dict[str, Any]]) -> dict[str, npt.NDArray[np.int64]]:
        """`char_ids` `[B, S, W]`, and `attention_mask`, `labels` and an all-zero `input_ids` `[B, S]`."""

def source_row_counts(config: str, split: str) -> list[tuple[str, int]]: ...
def derive_source_weights(
    fixed: list[tuple[str, float]] | None,
    source_reps: list[tuple[str, float]],
    rows_by_source: list[tuple[str, int]],
    samples: int,
) -> tuple[list[tuple[str, float]], list[tuple[str, float, int, float]]]: ...
