"""#727 stage-2 Phase 1 — the semi-Markov span scorer.

The two DP routines (log-partition, Viterbi) are verified against brute-force enumeration over ALL
valid segmentations of a tiny input, not smoke-tested. A dynamic program that is subtly wrong still
trains — it just trains toward the wrong thing — so the oracle is the point.
"""

import torch

from mailwoman_train.labels import ACTIVE_BIO_LABELS, LABEL_TO_ID
from mailwoman_train.model import MailwomanCoarseEncoder
from mailwoman_train.span_scorer import (
    NUM_SEGMENT_TYPES,
    O_TYPE_ID,
    SEGMENT_TYPES,
    TYPE_TO_ID,
    SemiMarkovCRF,
    SpanScorer,
    gold_segments,
)


def _brute_force_all_segmentations(seq_len: int, max_span: int, num_types: int):
    """Every valid segmentation of [0, seq_len) — O segments length 1, others up to max_span."""

    def rec(pos):
        if pos == seq_len:
            yield []
            return
        for length in range(1, min(max_span, seq_len - pos) + 1):
            for t in range(num_types):
                if t == O_TYPE_ID and length != 1:
                    continue
                for rest in rec(pos + length):
                    yield [(pos, length, t)] + rest

    return list(rec(0))


def _score_one(crf, span_scores_row, segmentation):
    """Score one segmentation the obvious way — the oracle the DP must reproduce."""
    starts = crf.start_transitions.detach()
    trans = crf.transitions.detach()
    ends = crf.end_transitions.detach()
    total = 0.0
    prev = None
    for i, length, t in segmentation:
        total += float(span_scores_row[i, length - 1, t])
        total += float(starts[t]) if prev is None else float(trans[prev, t])
        prev = t
    total += float(ends[prev])
    return total


def test_segment_types_derive_from_labels_with_O_first():
    assert SEGMENT_TYPES[0] == "O"
    assert TYPE_TO_ID["O"] == 0
    assert "street" in TYPE_TO_ID
    assert NUM_SEGMENT_TYPES == len(SEGMENT_TYPES)
    # every component in the BIO vocab has exactly one segment type
    assert len(set(SEGMENT_TYPES)) == len(SEGMENT_TYPES)


def test_gold_segments_groups_B_I_into_one_segment():
    # B-street I-street O B-locality  ->  (0,2,street) (2,1,O) (3,1,locality)
    labels = [
        LABEL_TO_ID["B-street"],
        LABEL_TO_ID["I-street"],
        LABEL_TO_ID["O"],
        LABEL_TO_ID["B-locality"],
    ]
    segs, ok = gold_segments(labels, max_span=8)
    assert ok is True
    assert segs == [
        (0, 2, TYPE_TO_ID["street"]),
        (2, 1, TYPE_TO_ID["O"]),
        (3, 1, TYPE_TO_ID["locality"]),
    ]


def test_gold_segments_stops_at_ignore_index():
    labels = [LABEL_TO_ID["B-street"], -100, -100]
    segs, ok = gold_segments(labels, max_span=8)
    assert ok is True
    assert segs == [(0, 1, TYPE_TO_ID["street"])]


def test_gold_segments_flags_unrepresentable_when_span_exceeds_max():
    labels = [LABEL_TO_ID["B-street"]] + [LABEL_TO_ID["I-street"]] * 5
    segs, ok = gold_segments(labels, max_span=3)
    assert ok is False  # 6-token span cannot be scored under max_span=3


def test_gold_segments_treats_orphan_I_as_a_segment_start():
    # Defensive: a stray I- with no B- (corrupt row) must not crash or merge backwards.
    labels = [LABEL_TO_ID["O"], LABEL_TO_ID["I-street"]]
    segs, ok = gold_segments(labels, max_span=8)
    assert ok is True
    assert segs == [(0, 1, TYPE_TO_ID["O"]), (1, 1, TYPE_TO_ID["street"])]


def test_span_scorer_output_shape():
    scorer = SpanScorer(hidden_size=16, span_dim=8, max_span=4)
    h = torch.randn(2, 7, 16)
    scores = scorer(h)
    assert scores.shape == (2, 7, 4, NUM_SEGMENT_TYPES)


def test_span_scorer_matches_explicit_per_span_computation():
    # The vectorised shift must equal the naive "start i, end i+l" computation.
    torch.manual_seed(0)
    scorer = SpanScorer(hidden_size=16, span_dim=8, max_span=3).eval()
    h = torch.randn(1, 5, 16)
    scores = scorer(h)
    starts = scorer.start_proj(h)
    ends = scorer.end_proj(h)
    for i in range(5):
        for span_len in range(3):
            j = i + span_len
            if j >= 5:
                continue
            expected = scorer.type_out(torch.tanh(starts[0, i] + ends[0, j]))
            torch.testing.assert_close(scores[0, i, span_len], expected)


def test_span_scorer_is_finite_on_extreme_input():
    scorer = SpanScorer(hidden_size=16, span_dim=8, max_span=4)
    scores = scorer(torch.full((1, 6, 16), 1e4))
    assert torch.isfinite(scores).all()


def test_log_partition_matches_brute_force_enumeration():
    torch.manual_seed(1)
    seq_len, max_span = 4, 2
    crf = SemiMarkovCRF(max_span=max_span)
    with torch.no_grad():
        crf.transitions.copy_(torch.randn(NUM_SEGMENT_TYPES, NUM_SEGMENT_TYPES))
        crf.start_transitions.copy_(torch.randn(NUM_SEGMENT_TYPES))
        crf.end_transitions.copy_(torch.randn(NUM_SEGMENT_TYPES))
    span_scores = torch.randn(1, seq_len, max_span, NUM_SEGMENT_TYPES)
    got = crf.log_partition(span_scores, torch.tensor([seq_len]))
    all_segs = _brute_force_all_segmentations(seq_len, max_span, NUM_SEGMENT_TYPES)
    expected = torch.logsumexp(torch.tensor([_score_one(crf, span_scores[0], s) for s in all_segs]), dim=0)
    torch.testing.assert_close(got[0], expected, rtol=1e-4, atol=1e-4)


def test_score_segmentation_matches_manual_sum():
    torch.manual_seed(2)
    crf = SemiMarkovCRF(max_span=3)
    span_scores = torch.randn(1, 5, 3, NUM_SEGMENT_TYPES)
    segs = [[(0, 2, TYPE_TO_ID["street"]), (2, 1, O_TYPE_ID), (3, 2, TYPE_TO_ID["locality"])]]
    got = crf.score_segmentation(span_scores, segs)
    expected = _score_one(crf, span_scores[0], segs[0])
    torch.testing.assert_close(got[0], torch.tensor(expected), rtol=1e-4, atol=1e-4)


def test_nll_is_non_negative_and_finite():
    torch.manual_seed(3)
    crf = SemiMarkovCRF(max_span=3)
    span_scores = torch.randn(1, 5, 3, NUM_SEGMENT_TYPES)
    segs = [[(0, 2, TYPE_TO_ID["street"]), (2, 1, O_TYPE_ID), (3, 2, TYPE_TO_ID["locality"])]]
    loss = crf.nll(span_scores, segs, torch.tensor([5]))
    assert torch.isfinite(loss).all()
    assert float(loss[0]) >= -1e-4  # logZ >= score(gold) for any single segmentation


def test_log_partition_runs_in_fp32_under_bf16_input():
    # The bf16 CRF NaN scar: the DP must upcast regardless of ambient dtype.
    crf = SemiMarkovCRF(max_span=2)
    span_scores = torch.randn(1, 4, 2, NUM_SEGMENT_TYPES, dtype=torch.bfloat16)
    out = crf.log_partition(span_scores, torch.tensor([4]))
    assert out.dtype == torch.float32
    assert torch.isfinite(out).all()


def test_log_partition_respects_per_row_lengths():
    # A padded row must score as if the padding did not exist.
    torch.manual_seed(4)
    crf = SemiMarkovCRF(max_span=2)
    full = torch.randn(1, 3, 2, NUM_SEGMENT_TYPES)
    padded = torch.cat([full, torch.randn(1, 2, 2, NUM_SEGMENT_TYPES)], dim=1)  # (1,5,2,T)
    a = crf.log_partition(full, torch.tensor([3]))
    b = crf.log_partition(padded, torch.tensor([3]))
    torch.testing.assert_close(a, b, rtol=1e-5, atol=1e-5)


def test_decode_matches_brute_force_argmax():
    torch.manual_seed(5)
    seq_len, max_span = 4, 2
    crf = SemiMarkovCRF(max_span=max_span)
    with torch.no_grad():
        crf.transitions.copy_(torch.randn(NUM_SEGMENT_TYPES, NUM_SEGMENT_TYPES))
        crf.start_transitions.copy_(torch.randn(NUM_SEGMENT_TYPES))
        crf.end_transitions.copy_(torch.randn(NUM_SEGMENT_TYPES))
    span_scores = torch.randn(1, seq_len, max_span, NUM_SEGMENT_TYPES)
    got = crf.decode(span_scores, torch.tensor([seq_len]))[0]
    all_segs = _brute_force_all_segmentations(seq_len, max_span, NUM_SEGMENT_TYPES)
    best = max(all_segs, key=lambda s: _score_one(crf, span_scores[0], s))
    assert got == best


def test_decode_output_covers_the_sequence_exactly():
    crf = SemiMarkovCRF(max_span=3)
    span_scores = torch.randn(2, 6, 3, NUM_SEGMENT_TYPES)
    for row_idx, row in enumerate(crf.decode(span_scores, torch.tensor([6, 4]))):
        expected_len = [6, 4][row_idx]
        covered = [i for (start, length, _) in row for i in range(start, start + length)]
        assert covered == sorted(covered)
        assert len(covered) == len(set(covered))  # no overlap
        assert covered == list(range(expected_len))  # no gap, exact coverage


def test_decode_never_emits_a_multi_token_O():
    crf = SemiMarkovCRF(max_span=4)
    span_scores = torch.zeros(1, 6, 4, NUM_SEGMENT_TYPES)
    span_scores[..., O_TYPE_ID] = 100.0  # try hard to force long O segments
    for _, length, t in crf.decode(span_scores, torch.tensor([6]))[0]:
        if t == O_TYPE_ID:
            assert length == 1


_GEOM = dict(
    vocab_size=64,
    hidden_size=16,
    num_hidden_layers=1,
    num_attention_heads=2,
    intermediate_size=32,
    max_position_embeddings=32,
    hidden_dropout_prob=0.0,
    num_labels=len(ACTIVE_BIO_LABELS),
    pad_token_id=0,
)


def test_span_head_cannot_influence_the_bio_logits():
    """The byte-identity invariant, tested as the PROPERTY rather than via seeded construction.

    Seeding two models and diffing logits does NOT test this: `_init_weights()` walks the module list,
    so adding a head shifts every subsequent RNG draw and the whole ENCODER differs — 100% of logits
    move for reasons that have nothing to do with the head, and at `init_from` (how this ships) the
    checkpoint's weights are loaded anyway, so draw order is irrelevant. What actually matters is that
    the head sits off the logits path: perturb it arbitrarily and the BIO logits must not move.
    """
    torch.manual_seed(7)
    model = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.5).eval()
    ids = torch.randint(1, 64, (1, 6))
    mask = torch.ones(1, 6, dtype=torch.long)
    with torch.no_grad():
        before = model(input_ids=ids, attention_mask=mask).logits.clone()
        for param in model.span_scorer.parameters():
            param.add_(torch.randn_like(param) * 10.0)
        for param in model.semi_crf.parameters():
            param.add_(torch.randn_like(param) * 10.0)
        after = model(input_ids=ids, attention_mask=mask).logits
    torch.testing.assert_close(before, after)


def test_span_head_shares_the_encoder_with_the_bio_head():
    """Same weights in => same logits. Guards against the head mutating `h` in place."""
    torch.manual_seed(11)
    with_head = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.5).eval()
    baseline = MailwomanCoarseEncoder(**_GEOM).eval()
    # Load the shared (non-span) weights into the baseline so both encoders are identical.
    shared = {k: v for k, v in with_head.state_dict().items() if not k.startswith(("span_scorer.", "semi_crf."))}
    missing, unexpected = baseline.load_state_dict(shared, strict=False)
    assert not unexpected
    ids = torch.randint(1, 64, (1, 6))
    mask = torch.ones(1, 6, dtype=torch.long)
    with torch.no_grad():
        torch.testing.assert_close(
            baseline(input_ids=ids, attention_mask=mask).logits,
            with_head(input_ids=ids, attention_mask=mask).logits,
        )


def test_span_scores_exposed_only_when_enabled():
    ids = torch.randint(1, 64, (1, 6))
    mask = torch.ones(1, 6, dtype=torch.long)
    model = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.5).eval()
    out = model(input_ids=ids, attention_mask=mask)
    assert out.span_scores is not None
    assert out.span_scores.shape[0] == 1
    baseline = MailwomanCoarseEncoder(**_GEOM).eval()
    assert baseline(input_ids=ids, attention_mask=mask).span_scores is None


def test_span_loss_contributes_and_is_finite():
    model = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.5)
    ids = torch.randint(1, 64, (2, 6))
    mask = torch.ones(2, 6, dtype=torch.long)
    labels = torch.full((2, 6), LABEL_TO_ID["O"])
    labels[:, 0] = LABEL_TO_ID["B-street"]
    labels[:, 1] = LABEL_TO_ID["I-street"]
    out = model(input_ids=ids, attention_mask=mask, labels=labels)
    assert out.loss is not None and torch.isfinite(out.loss)
    out.loss.backward()
    assert model.span_scorer.type_out.weight.grad is not None
    assert torch.isfinite(model.span_scorer.type_out.weight.grad).all()


def test_span_scorer_config_survives_save_load(tmp_path):
    model = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.25, max_span=5)
    model.save_pretrained(tmp_path)
    loaded = MailwomanCoarseEncoder.from_pretrained(tmp_path)
    assert loaded.use_span_scorer is True
    assert loaded.span_loss_weight == 0.25
    assert loaded.span_scorer.max_span == 5


def test_build_optimizer_gives_the_span_head_its_own_lr():
    """A FRESH head on a PRETRAINED encoder needs its own LR.

    The v3.0.0 probe inherited lr=1e-5 from a fine-tune recipe and the randomly-initialized span head
    barely moved in 2k steps (loss 26.4 -> 17.8, still falling; raw span NLL ~35 where a converged
    semi-CRF is O(1)). Param groups let the head run at 1e-3 while the encoder stays at 1e-5.
    """
    from mailwoman_train.train import build_optimizer

    model = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.5)
    optim = build_optimizer(model, learning_rate=1e-5, weight_decay=0.01, span_head_learning_rate=1e-3)
    assert len(optim.param_groups) == 2
    by_lr = {g["lr"]: g for g in optim.param_groups}
    assert set(by_lr) == {1e-5, 1e-3}
    # Every span/semi-CRF param is in the fast group; nothing else is.
    head_ids = {id(p) for n, p in model.named_parameters() if n.startswith(("span_scorer.", "semi_crf."))}
    fast_ids = {id(p) for p in by_lr[1e-3]["params"]}
    assert fast_ids == head_ids
    # Nothing is lost or double-counted.
    total = sum(len(g["params"]) for g in optim.param_groups)
    assert total == len(list(model.parameters()))


def test_build_optimizer_is_single_group_without_the_override():
    """Default (no span_head_learning_rate) must stay exactly what every prior recipe got."""
    from mailwoman_train.train import build_optimizer

    model = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.5)
    optim = build_optimizer(model, learning_rate=1e-5, weight_decay=0.01, span_head_learning_rate=None)
    assert len(optim.param_groups) == 1
    assert optim.param_groups[0]["lr"] == 1e-5
    assert len(optim.param_groups[0]["params"]) == len(list(model.parameters()))


def test_build_optimizer_respects_frozen_params():
    """A frozen param must not enter any group — the freeze_* idioms rely on it."""
    from mailwoman_train.train import build_optimizer

    model = MailwomanCoarseEncoder(**_GEOM, use_span_scorer=True, span_loss_weight=0.5)
    for name, p in model.named_parameters():
        if "token_embeddings" in name:
            p.requires_grad = False
    optim = build_optimizer(model, learning_rate=1e-5, weight_decay=0.01, span_head_learning_rate=1e-3)
    grouped = {id(p) for g in optim.param_groups for p in g["params"]}
    frozen = {id(p) for n, p in model.named_parameters() if "token_embeddings" in n}
    assert not (grouped & frozen)
