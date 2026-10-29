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
