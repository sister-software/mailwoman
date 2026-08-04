"""The JP 47-label head gets its own param group — proved on the SHIPPED config, not a fixture.

The v8 plans all carry the #727 head-expansion rule ("a freshly-added head/label group needs its own
param-group LR… bake this into the JP training config"). ``test_resurrection.py`` already pins the
generic mechanism on a 33-label toy. What was missing, and what burned a launch cycle in the 2026-07-22
en-GB run A, is proof that a REAL config file actually produces the groups it means to: that YAML's
levers were silently dropped by a stale volume-side config and the run proceeded with everything
inert. So these tests read ``configs/v8-jp-full.yaml`` off disk and assert on what
``build_model`` + ``build_optimizer`` do with it.

They also pin the GRANULARITY, because the plan's phrasing ("the cold new label rows") invites a
wrong assumption. ``classifier`` is one ``nn.Linear(384, 47)``. A PyTorch param group owns whole
tensors, so the 14 fresh JP rows (ids 33..46) CANNOT be given a different LR from the 33 stage3 rows
— they share a tensor. The carve-out is the whole head or nothing, and a gradient hook is not a
substitute (Adam's update is scale-invariant in the gradient). ``test_the_fourteen_fresh_rows_share_
one_tensor_with_the_other_thirty_three`` states that in code so the next reader does not go looking
for a row-level lever that does not exist.
"""

from __future__ import annotations

from pathlib import Path

import torch

from mailwoman_train.config import load_config
from mailwoman_train.labels import JP_FINE_TAGS, STAGE3_BIO_LABELS, resolve_label_set
from mailwoman_train.model import build_model
from mailwoman_train.train import _build_scheduler, build_optimizer

CONFIGS = Path(__file__).resolve().parents[2] / "src" / "mailwoman_train" / "configs"
FULL = CONFIGS / "v8-jp-full.yaml"
PROBE_2K = CONFIGS / "v8-jp-full-2k.yaml"

# The full shard's sealed train-split char vocab (build-report.json: char_vocab_size 2237). The
# vocab file lives on the data root; the size is all `build_model` needs, so the test stays offline.
CHAR_VOCAB_SIZE = 2237


def _model(cfg):
    # char_mode never reads the SP table — this mirrors train.py's own char-path call.
    return build_model(cfg, vocab_size=2, pad_token_id=0, char_vocab_size=CHAR_VOCAB_SIZE)


def _optimizer(cfg, model):
    return build_optimizer(
        model,
        learning_rate=cfg.train.learning_rate,
        weight_decay=cfg.train.weight_decay,
        span_head_learning_rate=cfg.train.span_head_learning_rate,
        classifier_learning_rate=cfg.train.classifier_learning_rate,
    )


def test_the_shipped_config_declares_the_head_lr_and_no_warm_start():
    cfg = load_config(FULL)
    assert cfg.data.label_set == "stage3-jp"
    assert cfg.data.char_mode == "char"
    assert cfg.train.classifier_learning_rate == 1e-3
    assert cfg.train.learning_rate == 5e-4
    # From scratch, deliberately: the probe checkpoint's (33, 384) classifier and 1,918-row char
    # embedding are both size-mismatched against this run, and `load_state_dict(strict=False)`
    # raises on a size mismatch (it only tolerates missing/unexpected KEYS).
    assert cfg.train.init_from == ""
    # `reinit_label_rows` requires init_from and is a no-op on a from-scratch model.
    assert cfg.train.reinit_label_rows == []


def test_build_optimizer_splits_the_47_label_head_into_its_own_group():
    cfg = load_config(FULL)
    model = _model(cfg)
    assert model.num_labels == 47

    optim, labels = _optimizer(cfg, model)

    assert labels == ["base", "classifier_learning_rate"]
    assert [g["lr"] for g in optim.param_groups] == [5e-4, 1e-3]

    hot = optim.param_groups[1]
    # Exactly the two classifier tensors — weight (47, 384) + bias (47) = 18,095 params. This is
    # the number the launch log prints as `[classifier_learning_rate] 18,095 params @ 0.001`.
    assert len(hot["params"]) == 2
    assert sum(p.numel() for p in hot["params"]) == 47 * cfg.model.hidden_size + 47 == 18095

    classifier_params = {id(p) for p in model.classifier.parameters()}
    assert {id(p) for p in hot["params"]} == classifier_params
    # …and the base group is everything else, non-empty (the encoder is NOT frozen here).
    base = optim.param_groups[0]
    assert base["params"]
    assert classifier_params.isdisjoint({id(p) for p in base["params"]})


def test_every_trainable_param_lands_in_exactly_one_group():
    """A carve-out that dropped params would train them at no LR at all — silently."""
    cfg = load_config(FULL)
    model = _model(cfg)
    optim, _ = _optimizer(cfg, model)

    grouped = [id(p) for g in optim.param_groups for p in g["params"]]
    trainable = {id(p) for p in model.parameters() if p.requires_grad}
    assert len(grouped) == len(set(grouped)), "a param appears in two groups"
    assert set(grouped) == trainable


def test_the_fourteen_fresh_rows_share_one_tensor_with_the_other_thirty_three():
    """Why the group is the whole head: `stage3-jp` appends its 7 tags, so the 14 fresh BIO rows are
    ids 33..46 of a SINGLE `nn.Linear` weight. Param groups own tensors, not rows."""
    jp = resolve_label_set("stage3-jp")
    fresh = [jp.label_to_id[f"{prefix}-{tag}"] for tag in JP_FINE_TAGS for prefix in ("B", "I")]

    assert len(fresh) == 14
    # Contiguous tail, immediately after the 33 stage3 labels — no interleaving with the old rows.
    assert sorted(fresh) == list(range(len(STAGE3_BIO_LABELS), len(jp.bio_labels)))
    assert len(STAGE3_BIO_LABELS) == 33 and len(jp.bio_labels) == 47
    # The stage3 ids are preserved verbatim, which is why a 33-label checkpoint would load
    # semantically "aligned" and still be wrong for this corpus (probe region == full prefecture).
    assert all(jp.label_to_id[label] == i for i, label in enumerate(STAGE3_BIO_LABELS))

    cfg = load_config(FULL)
    model = _model(cfg)
    assert model.classifier.weight.shape == (47, cfg.model.hidden_size)
    # One tensor covers rows 0..46. There is no per-row param group to build.
    assert len({id(p) for p in model.classifier.parameters()}) == 2


def test_the_scheduler_scales_both_groups_and_preserves_their_ratio():
    """`LambdaLR` multiplies each group's OWN `initial_lr`, so warmup/cosine composes for free."""
    cfg = load_config(FULL)
    model = _model(cfg)
    optim, _ = _optimizer(cfg, model)
    scheduler = _build_scheduler(optim, cfg.train)

    seen = []
    for _ in range(5):
        optim.step()
        scheduler.step()
        seen.append(tuple(g["lr"] for g in optim.param_groups))

    for base_lr, head_lr in seen:
        assert base_lr > 0 and head_lr > 0
        assert head_lr == 2 * base_lr  # 1e-3 / 5e-4, held across the whole schedule
    # Still inside warmup (200 < 1000 steps), so the LR is climbing, not annealing.
    assert seen[-1][0] > seen[0][0]


def test_the_2k_probe_builds_the_same_optimizer_shape_as_the_full_run():
    """The probe is only worth running if its optimizer matches what the full run will build."""
    full, probe = load_config(FULL), load_config(PROBE_2K)
    for field in ("label_set", "char_mode", "char_ctx", "max_unit_width", "max_units", "max_length"):
        assert getattr(probe.data, field) == getattr(full.data, field), field
    for field in ("learning_rate", "classifier_learning_rate", "batch_size", "weight_decay", "seed"):
        assert getattr(probe.train, field) == getattr(full.train, field), field

    labels_full = _optimizer(full, _model(full))[1]
    labels_probe = _optimizer(probe, _model(probe))[1]
    assert labels_probe == labels_full == ["base", "classifier_learning_rate"]


def test_dropping_the_head_lr_collapses_to_the_probe_recipes_single_group():
    """The documented fallback if the 2k read shows no separation: delete the key, get one group."""
    cfg = load_config(FULL)
    cfg.train.classifier_learning_rate = None
    optim, labels = _optimizer(cfg, _model(cfg))
    assert labels == ["base"]
    assert len(optim.param_groups) == 1
    assert optim.param_groups[0]["lr"] == 5e-4


def test_a_47_label_checkpoint_will_not_load_into_a_33_label_head():
    """The receipt behind the config's from-scratch note: strict=False does NOT tolerate a size
    mismatch, so warm-starting the probe checkpoint would crash rather than partially apply."""
    small, big = torch.nn.Linear(384, 33), torch.nn.Linear(384, 47)
    try:
        big.load_state_dict(small.state_dict(), strict=False)
    except RuntimeError as error:
        assert "size mismatch" in str(error)
    else:
        raise AssertionError("expected a size-mismatch RuntimeError")
