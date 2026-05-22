"""Linear-chain CRF unit tests.

Runs only in environments where ``torch`` is installed (corpus-python/.venv on the host
GPU, training containers). Skipped silently otherwise so the test file doesn't break the
lighter test-only venv used by the corpus build pipeline.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from mailwoman_train.crf import (  # noqa: E402  (after pytest.importorskip)
    LinearChainCRF,
    build_bio_start_mask,
    build_bio_transition_mask,
)
from mailwoman_train.labels import (  # noqa: E402
    ACTIVE_BIO_LABELS,
    ID_TO_LABEL,
    LABEL_TO_ID,
)


def test_transition_mask_rejects_orphan_i():
    mask = build_bio_transition_mask(ID_TO_LABEL)
    o = LABEL_TO_ID["O"]
    i_locality = LABEL_TO_ID["I-locality"]
    # O → I-locality is the orphan-I bug that Saint Petersburg hits on the demo.
    assert mask[o, i_locality].item() == float("-inf")
    # O → O is fine.
    assert mask[o, o].item() == 0.0
    # O → B-locality is fine.
    b_locality = LABEL_TO_ID["B-locality"]
    assert mask[o, b_locality].item() == 0.0


def test_transition_mask_rejects_cross_tag_i():
    mask = build_bio_transition_mask(ID_TO_LABEL)
    b_locality = LABEL_TO_ID["B-locality"]
    i_region = LABEL_TO_ID["I-region"]
    # B-locality → I-region (orphan-I cross-tag) must be rejected.
    assert mask[b_locality, i_region].item() == float("-inf")
    # B-locality → I-locality is the valid continuation.
    i_locality = LABEL_TO_ID["I-locality"]
    assert mask[b_locality, i_locality].item() == 0.0


def test_start_mask_rejects_i_prefix():
    mask = build_bio_start_mask(ID_TO_LABEL)
    o = LABEL_TO_ID["O"]
    b_country = LABEL_TO_ID["B-country"]
    i_country = LABEL_TO_ID["I-country"]
    assert mask[o].item() == 0.0
    assert mask[b_country].item() == 0.0
    assert mask[i_country].item() == float("-inf")


def test_log_likelihood_finite_and_negative_of_neg_log():
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    # Toy batch: B=2, S=5. Emissions are random; tags are valid B-locality runs.
    torch.manual_seed(0)
    emissions = torch.randn(2, 5, n)
    b_locality = LABEL_TO_ID["B-locality"]
    i_locality = LABEL_TO_ID["I-locality"]
    o = LABEL_TO_ID["O"]
    tags = torch.tensor(
        [
            [b_locality, i_locality, o, b_locality, o],
            [o, b_locality, i_locality, i_locality, o],
        ],
        dtype=torch.long,
    )
    mask = torch.ones(2, 5)
    nll = crf(emissions=emissions, tags=tags, mask=mask)
    assert torch.isfinite(nll)
    assert nll.item() >= 0.0  # NLL is non-negative by construction


def test_log_likelihood_finite_with_padding():
    # Regression guard for the multiplicative-mask NaN trap. alpha carries -inf at
    # structurally-invalid start positions (I-* tags), and the partition recurrence
    # used to blend old vs new alpha with `alpha * (1 - mask_t)`, which evaluates
    # `0 * -inf = NaN` whenever mask_t = 1. The torch.where blend preserves -inf
    # cleanly. Exercise both the full-mask and partial-mask paths.
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    torch.manual_seed(0)
    emissions = torch.randn(2, 5, n)
    b_locality = LABEL_TO_ID["B-locality"]
    i_locality = LABEL_TO_ID["I-locality"]
    o = LABEL_TO_ID["O"]
    # Row 0 padded after 3 real tokens; row 1 full.
    tags = torch.tensor(
        [
            [b_locality, i_locality, o, 0, 0],
            [o, b_locality, i_locality, i_locality, o],
        ],
        dtype=torch.long,
    )
    mask = torch.tensor([[1, 1, 1, 0, 0], [1, 1, 1, 1, 1]], dtype=torch.float)
    nll = crf(emissions=emissions, tags=tags, mask=mask)
    assert torch.isfinite(nll)
    assert nll.item() >= 0.0


def test_viterbi_never_emits_orphan_i():
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    # Adversarial emissions: push hard toward I-locality at every position. Without the
    # structural mask, Viterbi would emit [I-locality]*5 — invalid. With the mask, it
    # must route through a B-locality first or just stay on O / B-*.
    i_locality = LABEL_TO_ID["I-locality"]
    emissions = torch.full((1, 5, n), -10.0)
    emissions[0, :, i_locality] = 10.0
    mask = torch.ones(1, 5)
    decoded = crf.viterbi_decode(emissions, mask)
    assert len(decoded) == 1
    seq = decoded[0]
    # Either start with O / B-*, or start with B-locality then I-locality runs.
    for idx, tag_id in enumerate(seq):
        label = ID_TO_LABEL[tag_id]
        if not label.startswith("I-"):
            continue
        if idx == 0:
            pytest.fail(f"sequence starts with I-* (orphan): {label}")
        prev = ID_TO_LABEL[seq[idx - 1]]
        # I-X is valid only after B-X or I-X with same tag.
        assert prev.startswith(("B-", "I-")), f"orphan-I at {idx}: prev={prev}, curr={label}"
        _, prev_tag = prev.split("-", 1)
        _, curr_tag = label.split("-", 1)
        assert prev_tag == curr_tag, f"cross-tag I at {idx}: prev={prev}, curr={label}"


def test_viterbi_respects_mask_length():
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    emissions = torch.randn(2, 5, n)
    mask = torch.tensor([[1, 1, 1, 0, 0], [1, 1, 1, 1, 1]], dtype=torch.float)
    decoded = crf.viterbi_decode(emissions, mask)
    assert len(decoded[0]) == 3  # mask cuts row 0 at length 3
    assert len(decoded[1]) == 5
