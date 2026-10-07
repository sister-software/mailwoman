"""Linear-chain CRF unit tests.

- Runs only when ``torch`` is installed.
- If ``torch`` is missing, pytest skips this file.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from mailwoman_train.labels import (  # noqa: E402
    ACTIVE_BIO_LABELS,
    ID_TO_LABEL,
    LABEL_TO_ID,
)
from mailwoman_train.nn.crf import (  # noqa: E402  (after pytest.importorskip)
    LinearChainCRF,
    build_bio_start_mask,
    build_bio_transition_mask,
)


def test_transition_mask_rejects_orphan_i():
    mask = build_bio_transition_mask(ID_TO_LABEL)
    o = LABEL_TO_ID["O"]
    i_locality = LABEL_TO_ID["I-locality"]
    # Invalid: O -> I-locality (orphan I-*).
    assert mask[o, i_locality].item() == float("-inf")
    # Valid: O -> O.
    assert mask[o, o].item() == 0.0
    # Valid: O -> B-locality.
    b_locality = LABEL_TO_ID["B-locality"]
    assert mask[o, b_locality].item() == 0.0


def test_transition_mask_rejects_cross_tag_i():
    mask = build_bio_transition_mask(ID_TO_LABEL)
    b_locality = LABEL_TO_ID["B-locality"]
    i_region = LABEL_TO_ID["I-region"]
    # Invalid: B-locality -> I-region (cross-tag I-*).
    assert mask[b_locality, i_region].item() == float("-inf")
    # Valid continuation: B-locality -> I-locality.
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
    # Toy batch: B=2, S=5.
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


def test_per_token_reduction_matches_sum_over_tokens():
    """Check reduction math.

    - per_token = sum / number_of_real_tokens
    - mean = sum / batch_size
    - per_token and mean should differ when token count != batch size
    """
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    torch.manual_seed(0)
    emissions = torch.randn(2, 5, n)
    b_locality = LABEL_TO_ID["B-locality"]
    i_locality = LABEL_TO_ID["I-locality"]
    o = LABEL_TO_ID["O"]
    tags = torch.tensor(
        [
            [b_locality, i_locality, o, 0, 0],
            [o, b_locality, i_locality, i_locality, o],
        ],
        dtype=torch.long,
    )
    mask = torch.tensor([[1, 1, 1, 0, 0], [1, 1, 1, 1, 1]], dtype=torch.float)

    nll_sum = crf(emissions=emissions, tags=tags, mask=mask, reduction="sum")
    nll_per_token = crf(emissions=emissions, tags=tags, mask=mask, reduction="per_token")
    nll_mean = crf(emissions=emissions, tags=tags, mask=mask, reduction="mean")

    total_tokens = mask.sum()
    assert torch.isfinite(nll_per_token)
    # per_token = sum / total_tokens
    assert torch.allclose(nll_per_token, nll_sum / total_tokens)
    # mean = sum / batch_size (2)
    assert torch.allclose(nll_mean, nll_sum / 2.0)
    # Should differ here because total_tokens != batch_size.
    assert not torch.allclose(nll_mean, nll_per_token)


def test_unknown_reduction_raises():
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    emissions = torch.randn(1, 3, n)
    tags = torch.zeros(1, 3, dtype=torch.long)
    mask = torch.ones(1, 3)
    try:
        crf(emissions=emissions, tags=tags, mask=mask, reduction="bogus")
    except ValueError as e:
        assert "bogus" in str(e)
        return
    raise AssertionError("expected ValueError on unknown reduction")


def test_log_likelihood_finite_with_padding():
    # Regression guard: masked timesteps must not create NaNs.
    # The masked case produces 0 * -inf in DP updates. That is where the NaNs came from.
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    torch.manual_seed(0)
    emissions = torch.randn(2, 5, n)
    b_locality = LABEL_TO_ID["B-locality"]
    i_locality = LABEL_TO_ID["I-locality"]
    o = LABEL_TO_ID["O"]
    # Row 0 is padded after 3 tokens. Row 1 uses all tokens.
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
    # Adversarial setup: every position strongly prefers I-locality.
    # Decoder must still obey BIO constraints.
    i_locality = LABEL_TO_ID["I-locality"]
    emissions = torch.full((1, 5, n), -10.0)
    emissions[0, :, i_locality] = 10.0
    mask = torch.ones(1, 5)
    decoded = crf.viterbi_decode(emissions, mask)
    assert len(decoded) == 1
    seq = decoded[0]
    for idx, tag_id in enumerate(seq):
        label = ID_TO_LABEL[tag_id]
        if not label.startswith("I-"):
            continue
        if idx == 0:
            pytest.fail(f"sequence starts with I-* (orphan): {label}")
        prev = ID_TO_LABEL[seq[idx - 1]]
        # I-X is valid only after B-X or I-X with the same tag.
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
    assert len(decoded[0]) == 3  # mask truncates row 0 at length 3
    assert len(decoded[1]) == 5


# endregion

# region top-k decode


def test_top_k_decode_returns_argmax_as_first_path():
    """Top-1 from top-k should match regular Viterbi."""
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    torch.manual_seed(7)
    emissions = torch.randn(3, 8, n)
    mask = torch.ones(3, 8)
    argmax = crf.viterbi_decode(emissions, mask)
    top_k = crf.top_k_decode(emissions, mask, k=5)
    assert len(top_k) == 3
    for row_argmax, row_paths in zip(argmax, top_k, strict=True):
        assert len(row_paths) >= 1
        assert row_paths[0].sequence == row_argmax


def test_top_k_decode_scores_sorted_desc():
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    torch.manual_seed(3)
    emissions = torch.randn(2, 10, n)
    mask = torch.ones(2, 10)
    top_k = crf.top_k_decode(emissions, mask, k=5)
    for row in top_k:
        scores = [p.score for p in row]
        assert scores == sorted(scores, reverse=True)


def test_top_k_decode_paths_are_distinct():
    """Returned top-k paths must be distinct sequences."""
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    torch.manual_seed(11)
    emissions = torch.randn(1, 6, n)
    mask = torch.ones(1, 6)
    paths = crf.top_k_decode(emissions, mask, k=5)[0]
    seen: set[tuple[int, ...]] = set()
    for p in paths:
        seq_tuple = tuple(p.sequence)
        assert seq_tuple not in seen, f"duplicate path returned: {seq_tuple}"
        seen.add(seq_tuple)


def test_top_k_decode_respects_mask_length():
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    torch.manual_seed(1)
    emissions = torch.randn(2, 7, n)
    mask = torch.tensor([[1, 1, 1, 1, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1]], dtype=torch.float)
    top_k = crf.top_k_decode(emissions, mask, k=3)
    for p in top_k[0]:
        assert len(p.sequence) == 4
    for p in top_k[1]:
        assert len(p.sequence) == 7


def test_top_k_decode_never_emits_orphan_i():
    """BIO constraints must hold for every top-k path."""
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    # Adversarial setup: all positions strongly favor I-locality.
    i_locality = LABEL_TO_ID["I-locality"]
    emissions = torch.full((1, 5, n), -10.0)
    emissions[0, :, i_locality] = 10.0
    mask = torch.ones(1, 5)
    top_k = crf.top_k_decode(emissions, mask, k=5)[0]
    assert len(top_k) >= 1
    for path in top_k:
        for idx, tag_id in enumerate(path.sequence):
            label = ID_TO_LABEL[tag_id]
            if not label.startswith("I-"):
                continue
            if idx == 0:
                pytest.fail(f"top-k path starts with I-* (orphan): {label}")
            prev = ID_TO_LABEL[path.sequence[idx - 1]]
            assert prev.startswith(("B-", "I-")), f"orphan-I at {idx}: prev={prev}, curr={label}"
            _, prev_tag = prev.split("-", 1)
            _, curr_tag = label.split("-", 1)
            assert prev_tag == curr_tag, f"cross-tag I at {idx}: prev={prev}, curr={label}"


def test_top_k_decode_calibrated_scores_are_log_probs():
    """Scores are log-probabilities: sum(exp(score)) over returned paths is <= 1."""
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    torch.manual_seed(0)
    emissions = torch.randn(1, 6, n)
    mask = torch.ones(1, 6)
    paths = crf.top_k_decode(emissions, mask, k=10)[0]
    probs = [float(torch.tensor(p.score).exp()) for p in paths]
    s = sum(probs)
    # Small slack for fp32 rounding. The exact invariant is sum <= 1.
    assert s <= 1.0 + 1e-5, f"top-k probabilities sum to {s} > 1"
    # All returned scores should be finite.
    assert all(math_isfinite(p.score) for p in paths)


def math_isfinite(x: float) -> bool:
    return x == x and abs(x) != float("inf")


def test_top_k_decode_k_one_matches_viterbi():
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    torch.manual_seed(5)
    emissions = torch.randn(2, 6, n)
    mask = torch.ones(2, 6)
    argmax = crf.viterbi_decode(emissions, mask)
    top_1 = crf.top_k_decode(emissions, mask, k=1)
    for row_argmax, row_paths in zip(argmax, top_1, strict=True):
        assert len(row_paths) == 1
        assert row_paths[0].sequence == row_argmax


def test_top_k_decode_bad_k_raises():
    n = len(ACTIVE_BIO_LABELS)
    crf = LinearChainCRF(n, ID_TO_LABEL)
    emissions = torch.randn(1, 3, n)
    mask = torch.ones(1, 3)
    with pytest.raises(ValueError):
        crf.top_k_decode(emissions, mask, k=0)
