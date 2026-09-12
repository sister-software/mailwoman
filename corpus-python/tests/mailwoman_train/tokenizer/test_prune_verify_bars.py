"""The vocab-pruning probe's two bars, against tokenizers and graphs that disagree on purpose.

Nothing exercised either. Both bars need a SentencePiece pair and an int8 ONNX pair to run, so the
counting itself — the part that decides PASS or FAIL — was reachable only from a full probe run,
where a bar that counts nothing and a bar that finds nothing print the same line.

Both bars are one-sided in the direction that matters: a bar that under-counts reports a sound
surgery. So each case here is a KNOWN difference, and the test asserts it was found.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pytest

from mailwoman_train.tokenizer.vocab.prune_verify import (
    check_logit_parity,
    check_segmentation_identity,
    feeds_for,
)

#: Original id -> pruned id. Id 3 was dropped, which is what -1 means to both bars.
OLD_TO_NEW = np.array([0, 1, 2, -1, 3, 4], dtype=np.int64)


@dataclass
class StubProcessor:
    """A SentencePieceProcessor's `encode`, over a fixed table of text -> ids."""

    table: dict[str, list[int]]
    pieces: dict[str, list[str]] = field(default_factory=dict)

    def encode(self, text: str, out_type: type[str] | None = None) -> list[Any]:
        if out_type is str:
            return self.pieces.get(text, list(text))
        return self.table[text]


@dataclass(frozen=True)
class StubMeta:
    """An ONNX input meta: a name, a declared type, and a shape with symbolic dimensions."""

    name: str
    type: str
    shape: tuple[Any, ...]


@dataclass
class StubSession:
    """An InferenceSession that answers a fixed output per `input_ids` row."""

    metas: list[StubMeta]
    outputs: dict[tuple[int, ...], list[np.ndarray]]

    def get_inputs(self) -> list[StubMeta]:
        return self.metas

    def run(self, _outputs: None, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        return self.outputs[tuple(feeds["input_ids"][0].tolist())]


def test_identical_segmentation_counts_no_difference() -> None:
    orig = StubProcessor({"a": [1, 2], "b": [4, 5]})
    pruned = StubProcessor({"a": [1, 2], "b": [3, 4]})

    assert check_segmentation_identity(orig, pruned, OLD_TO_NEW, ["a", "b"], "case") == 0


def test_a_dropped_piece_counts_as_a_difference() -> None:
    """Id 3 maps to -1: the pruned vocabulary cannot represent this text at all."""
    orig = StubProcessor({"gone": [1, 3]})
    pruned = StubProcessor({"gone": [1, 2]})

    assert check_segmentation_identity(orig, pruned, OLD_TO_NEW, ["gone"], "case") == 1


def test_a_resegmented_text_counts_as_a_difference() -> None:
    """The same pieces in a different arrangement is exactly what B1 exists to catch."""
    orig = StubProcessor({"split": [4, 5]})
    pruned = StubProcessor({"split": [3]})

    assert check_segmentation_identity(orig, pruned, OLD_TO_NEW, ["split"], "case") == 1


METAS = [
    StubMeta("input_ids", "tensor(int64)", ("batch", "sequence")),
    StubMeta("attention_mask", "tensor(int64)", ("batch", "sequence")),
    StubMeta("anchor_features", "tensor(float)", ("batch", "sequence", "23")),
]


def test_feeds_resolve_every_symbolic_dimension() -> None:
    """A symbolic dimension left unresolved is a feed the session refuses, not a wrong number."""
    feeds = feeds_for(METAS, [1, 2, 4])

    assert feeds["input_ids"].tolist() == [[1, 2, 4]]
    assert feeds["attention_mask"].shape == (1, 3)
    assert feeds["attention_mask"].dtype == np.int64
    assert feeds["anchor_features"].shape == (1, 3, 23)
    assert feeds["anchor_features"].dtype == np.float32
    assert not feeds["anchor_features"].any(), "channels are fed zeros"


def test_bit_equal_outputs_count_no_difference() -> None:
    logits = np.array([[[0.25, 0.5]]], dtype=np.float32)
    orig = StubProcessor({"a": [1, 2]})
    orig_session = StubSession(METAS, {(1, 2): [logits]})
    pruned_session = StubSession(METAS, {(1, 2): [logits.copy()]})

    assert check_logit_parity(orig, OLD_TO_NEW, orig_session, pruned_session, ["a"]) == 0


def test_outputs_differing_in_one_bit_count_as_a_difference() -> None:
    """The bar is BITWISE: the kept embedding rows are byte-identical, so near-equal is a failure."""
    logits = np.array([[[0.25, 0.5]]], dtype=np.float32)
    nudged = logits.copy()
    nudged[0, 0, 1] = np.nextafter(np.float32(0.5), np.float32(1.0))
    orig = StubProcessor({"a": [4, 5]})
    orig_session = StubSession(METAS, {(4, 5): [logits]})
    pruned_session = StubSession(METAS, {(3, 4): [nudged]})

    assert check_logit_parity(orig, OLD_TO_NEW, orig_session, pruned_session, ["a"]) == 1


def test_an_unmapped_id_raises_rather_than_scoring() -> None:
    """Feeding a graph inputs it cannot represent would score the surgery against nothing."""
    orig = StubProcessor({"gone": [1, 3]})
    session = StubSession(METAS, {})

    with pytest.raises(ValueError, match="unmapped id"):
        check_logit_parity(orig, OLD_TO_NEW, session, session, ["gone"])
