"""Structural parity test for the collate → ``_to_tensor_batch`` seam (#1349).

Every optional channel travels the same three-hop path: the loader paints per-piece features onto
``EncodedExample``, ``collate`` emits them keyed by name, and ``_to_tensor_batch`` converts each key
to a device tensor for ``model(**tb)``. The first two hops are presence-driven (a configured lexicon
adds the key); the third is a hand-maintained if-chain — and a key it misses disappears SILENTLY,
because the model's forward zero-fills absent channel tensors. That is exactly how the locality-
surface channel trained on zeros from v3.16.0 through the shipped v3.24.0 bundle (#1349): the
shipped model's ``locality_surface_token_embedding`` is still exactly zeros-init.

The invariant enforced here: with EVERY optional channel populated, ``_to_tensor_batch`` must emit
EXACTLY the keys ``collate`` produced. Equality (not subset) is deliberate — an extra key would
crash ``model(**tb)`` loudly, a dropped key is the silent failure this test exists to catch. Adding
a channel to ``EncodedExample``/``collate`` without the tensor conversion now fails here instead of
shipping a frozen-at-init projection.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")  # training deps (torch) aren't installed in lint-only envs

from mailwoman_train.data_loader import EncodedExample, collate  # noqa: E402
from mailwoman_train.labels import IGNORE_INDEX  # noqa: E402
from mailwoman_train.train import _to_tensor_batch  # noqa: E402

SEQ = 4


def _full_example() -> EncodedExample:
    """An ``EncodedExample`` with every optional channel populated (the all-channels-on shape)."""
    return EncodedExample(
        input_ids=[5, 6, 7, 0],
        attention_mask=[1, 1, 1, 0],
        labels=[0, 1, 2, IGNORE_INDEX],
        locale_id=0,
        anchor_features=[[0.5] * 11 for _ in range(SEQ)],
        anchor_confidence=[1.0] * SEQ,
        gazetteer_features=[[1.0] * 5 for _ in range(SEQ)],
        gazetteer_confidence=[1.0] * SEQ,
        country_features=[[1.0, 0.0] for _ in range(SEQ)],
        country_confidence=[1.0] * SEQ,
        street_type_features=[[1.0] for _ in range(SEQ)],
        street_type_confidence=[1.0] * SEQ,
        locality_surface_features=[[1.0, 0.0] for _ in range(SEQ)],
        locality_surface_confidence=[1.0] * SEQ,
    )


def test_every_optional_channel_is_exercised_by_the_fixture() -> None:
    """If a new channel lands on ``EncodedExample``, this fixture must grow with it."""
    ex = _full_example()
    unpopulated = [name for name, value in vars(ex).items() if value is None]
    assert unpopulated == [], f"_full_example() must populate every EncodedExample field: {unpopulated}"


def test_to_tensor_batch_converts_every_collate_key() -> None:
    batch = collate([_full_example(), _full_example()])
    tb = _to_tensor_batch(batch, torch.device("cpu"))
    assert set(tb.keys()) == set(batch.keys()), (
        f"collate/_to_tensor_batch key mismatch — dropped: {sorted(set(batch) - set(tb))}, "
        f"invented: {sorted(set(tb) - set(batch))}"
    )
    for key, value in tb.items():
        assert isinstance(value, torch.Tensor), f"{key} did not convert to a tensor"


def test_locality_surface_tensors_reach_the_batch() -> None:
    """The #1349 regression pinned directly: the locality pair must survive the conversion."""
    batch = collate([_full_example()])
    tb = _to_tensor_batch(batch, torch.device("cpu"))
    assert tb["locality_surface_features"].shape == (1, SEQ, 2)
    assert tb["locality_surface_confidence"].shape == (1, SEQ)
    assert float(tb["locality_surface_features"].abs().sum()) > 0.0
