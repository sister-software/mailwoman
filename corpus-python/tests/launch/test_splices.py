"""The splice table, checked for the shapes a seven-way clone could hide.

Each row grows one checkpoint's embeddings onto a wider tokenizer. The values were seven Modal
functions differing only in five paths and a vocabulary pair, and two of the defects below were
live in that shape: one function wrote `nsplice-v2-expanded` while its message said
`nsplice-expanded`, and every expected vocabulary size sat in a docstring where nothing could read
it. Both become checkable once the values are data.
"""

from __future__ import annotations

import pytest
from launch.splices import SPLICES


def test_no_two_splices_write_the_same_destination() -> None:
    """A shared destination means the second run silently overwrites the first one's base."""
    destinations = [entry.destination for entry in SPLICES.values()]
    duplicated = {path for path in destinations if destinations.count(path) > 1}
    assert not duplicated, f"these splices write over each other: {sorted(duplicated)}"


@pytest.mark.parametrize("name", sorted(SPLICES))
def test_each_splice_grows_rather_than_shrinks(name: str) -> None:
    """A recorded pair must be an EXPANSION. A narrower target is a splice nobody meant to run."""
    entry = SPLICES[name]
    if entry.vocabulary is None:
        pytest.skip(f"{name} has no measured vocabulary pair")
    old, new = entry.vocabulary
    assert new > old, f"{name} records {old} -> {new}, which is not an expansion"


@pytest.mark.parametrize("name", sorted(SPLICES))
def test_each_splice_names_two_different_tokenizers(name: str) -> None:
    entry = SPLICES[name]
    assert entry.from_tokenizer != entry.to_tokenizer, f"{name} splices a tokenizer onto itself"


@pytest.mark.parametrize("name", sorted(SPLICES))
def test_every_path_is_volume_relative(name: str) -> None:
    """`mean_init` prefixes each with the mount, so a leading slash would produce `/data//data/...`."""
    entry = SPLICES[name]
    for field in (entry.checkpoint, entry.destination, entry.from_tokenizer, entry.to_tokenizer):
        assert not field.startswith("/"), f"{name}: {field} is absolute; the paths here are volume-relative"


def test_a_chain_of_splices_agrees_on_its_shared_vocabulary_size() -> None:
    """Where one splice's target tokenizer is another's source, the recorded sizes must match.

    The chain is the thing the seven docstrings could not keep straight: fr_nsplice ends at 66,319
    and multisplice starts there. A mismatch says one of the two pairs was copied from the wrong run.
    """
    ends = {entry.to_tokenizer: entry.vocabulary[1] for entry in SPLICES.values() if entry.vocabulary}
    starts = {entry.from_tokenizer: entry.vocabulary[0] for entry in SPLICES.values() if entry.vocabulary}

    shared = set(ends) & set(starts)
    assert shared, "no splice chains onto another — the check has no subject"
    disagreements = {
        tokenizer: (ends[tokenizer], starts[tokenizer]) for tokenizer in shared if ends[tokenizer] != starts[tokenizer]
    }
    assert not disagreements, f"a tokenizer with two recorded sizes: {disagreements}"
