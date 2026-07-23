"""`train.trainable_only_prefixes` — the cRT probe lever (classifier-only retraining, frozen
encoder). See docs/superpowers/plans/2026-07-22-placetype-census-bias.md "Parallel training-side
experiment" and the v3.12.0-crt-probe.yaml config that exercises it.

Covers:
  - the config field default (empty = no-op) and that `load_config` round-trips the shipped
    v3.12.0-crt-probe.yaml's delta correctly against its v3.11.0-deploc-feed.yaml parent
  - `build_optimizer`'s empty-base-group skip: when every non-carved-out param is frozen (as
    trainable_only_prefixes=["classifier."] does upstream in train.py), `rest` is empty and the
    optimizer must come out as a clean 1-group shape, not a 2-group shape with a permanently-empty
    phantom "base" group
  - the pre-existing 3-group shape (span_head + classifier carve-outs, `rest` non-empty) is
    unaffected by that skip
  - raw torch AdamW/LambdaLR tolerate an all-carved-out (would-be-empty) group construction,
    step, and state_dict round trip cleanly — the evidence behind the "prove it's safe" half of
    the empty-group question (this repo instead chose to skip inserting it, per build_optimizer's
    docstring, but the underlying torch behavior is pinned here too so the "unsafe" alternative
    reading can't creep back in unnoticed)
"""

from pathlib import Path

import pytest
import torch
import yaml
from torch.optim import AdamW
from torch.optim.lr_scheduler import LambdaLR

from mailwoman_train.config import TrainConfig, load_config
from mailwoman_train.train import build_optimizer

CONFIG_DIR = Path(__file__).resolve().parents[2] / "src" / "mailwoman_train" / "configs"


class TinyModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = torch.nn.Linear(4, 4)
        self.classifier = torch.nn.Linear(4, 33)


class TinySpanClassifierModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = torch.nn.Linear(4, 4)
        self.span_scorer = torch.nn.Linear(4, 4)
        self.classifier = torch.nn.Linear(4, 33)


# --- Config field -----------------------------------------------------------------------------


def test_trainable_only_prefixes_defaults_empty():
    cfg = TrainConfig()
    assert cfg.trainable_only_prefixes == []


def test_v3120_crt_probe_config_loads_the_one_variable():
    cfg = load_config(CONFIG_DIR / "v3.12.0-crt-probe.yaml")
    assert cfg.train.trainable_only_prefixes == ["classifier."]
    # UNCHANGED-from-parent levers (same stream, same resurrection levers, same 8k) — the ONE
    # variable claim is only true if these actually match v3.11.0-deploc-feed.yaml.
    parent = load_config(CONFIG_DIR / "v3.11.0-deploc-feed.yaml")
    assert cfg.data == parent.data
    assert cfg.model == parent.model
    assert cfg.train.classifier_learning_rate == parent.train.classifier_learning_rate == 1.0e-3
    assert cfg.train.reinit_label_rows == parent.train.reinit_label_rows
    assert cfg.train.init_from == parent.train.init_from
    assert cfg.train.max_steps == parent.train.max_steps == 8000
    assert cfg.train.learning_rate == parent.train.learning_rate
    # The deltas this task explicitly authorizes, and only these.
    assert cfg.train.output_dir != parent.train.output_dir
    assert cfg.train.trackio_run_name != parent.train.trackio_run_name
    assert cfg.train.trainable_only_prefixes != parent.train.trainable_only_prefixes


def test_v3120_crt_probe_config_freeze_flags_stay_off():
    """Mutual exclusivity is enforced in train.py, but the SHIPPED config itself must also not
    trip it — trainable_only_prefixes is meant to stand alone."""
    cfg = load_config(CONFIG_DIR / "v3.12.0-crt-probe.yaml")
    assert cfg.train.freeze_encoder is False
    assert cfg.train.freeze_token_embeddings is False


# --- build_optimizer: empty-base-group skip ---------------------------------------------------


def test_all_carved_out_yields_a_clean_one_group_optimizer():
    """The cRT-probe shape: everything but `classifier.` is frozen upstream (train.py), so the
    ONLY name left in `trainable` by the time build_optimizer runs is `classifier.` itself. With
    classifier_learning_rate also set, the carve-out consumes 100% of `trainable` and `rest` is
    empty — build_optimizer must skip inserting a "base" group for it, not construct a permanently
    -empty phantom group."""
    m = TinyModel()
    for name, p in m.named_parameters():
        p.requires_grad = name.startswith("classifier.")  # mirrors train.py's frozen-upstream state

    optim, labels = build_optimizer(m, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)

    assert len(optim.param_groups) == 1
    assert labels == ["classifier_learning_rate"]
    assert optim.param_groups[0]["lr"] == 1e-3
    assert sum(p.numel() for p in optim.param_groups[0]["params"]) == 33 * 4 + 33


def test_all_carved_out_without_lr_override_is_also_one_group():
    """trainable_only_prefixes alone (no classifier_learning_rate override) takes the
    no-carveouts path entirely — `build_optimizer`'s pre-existing `if not carveouts` branch,
    unaffected by this change, over whatever `trainable` already is upstream."""
    m = TinyModel()
    for name, p in m.named_parameters():
        p.requires_grad = name.startswith("classifier.")

    optim, labels = build_optimizer(m, learning_rate=1e-5, weight_decay=0.01)

    assert len(optim.param_groups) == 1
    assert labels == ["base"]
    assert sum(p.numel() for p in optim.param_groups[0]["params"]) == 33 * 4 + 33


def test_three_group_shape_unaffected_by_the_empty_group_skip():
    """Pre-existing shape (span_head_learning_rate AND classifier_learning_rate, encoder still
    trainable so `rest` is non-empty) must be untouched by the `if rest:` guard — the base group
    still gets inserted when it actually has params."""
    m = TinySpanClassifierModel()
    optim, labels = build_optimizer(
        m,
        learning_rate=1e-5,
        weight_decay=0.01,
        span_head_learning_rate=1e-3,
        classifier_learning_rate=1e-2,
    )
    assert len(optim.param_groups) == 3
    assert labels == ["base", "span_head_learning_rate", "classifier_learning_rate"]
    base_group = optim.param_groups[0]
    assert sum(p.numel() for p in base_group["params"]) == 4 * 4 + 4  # encoder only


# --- Raw torch: empty param-group safety (the "prove it's safe" evidence) ---------------------


def test_raw_adamw_tolerates_an_empty_param_group():
    """AdamW's own behavior with a zero-params group: constructs, steps, and round-trips its
    state_dict cleanly. This is the evidence behind choosing NOT to special-case away from an
    empty group for safety reasons — the skip in build_optimizer is a shape/readability choice
    (no permanently-empty phantom "base" label), not a workaround for broken torch behavior."""
    lin = torch.nn.Linear(4, 4)
    groups = [{"params": [], "lr": 1e-5}, {"params": list(lin.parameters()), "lr": 1e-3}]

    optim = AdamW(groups, lr=1e-5, weight_decay=0.01)
    assert len(optim.param_groups) == 2

    x = torch.randn(2, 4)
    lin(x).sum().backward()
    optim.step()
    optim.zero_grad()

    state = optim.state_dict()
    assert state["param_groups"][0]["params"] == []

    optim2 = AdamW(groups, lr=1e-5, weight_decay=0.01)
    optim2.load_state_dict(state)  # must not raise
    assert optim2.param_groups[0]["params"] == []


def test_raw_lambdalr_tolerates_an_empty_param_group():
    """A single shared `lr_lambda` (this repo's `_constant_with_warmup`/`_cosine_with_warmup`
    pattern) applies per-group regardless of param count — an empty group gets a base_lr entry
    and steps like any other."""
    lin = torch.nn.Linear(4, 4)
    groups = [{"params": [], "lr": 1e-5}, {"params": list(lin.parameters()), "lr": 1e-3}]
    optim = AdamW(groups, lr=1e-5, weight_decay=0.01)

    sched = LambdaLR(optim, lambda step: 1.0 if step >= 2 else float(step) / 2.0)
    for _ in range(5):
        sched.step()

    assert len(sched.base_lrs) == 2
    assert optim.param_groups[0]["lr"] == pytest.approx(1e-5)
    assert optim.param_groups[1]["lr"] == pytest.approx(1e-3)


# --- Every shipped config: trainable_only_prefixes vs freeze_* mutual exclusivity -------------


@pytest.mark.parametrize("config_path", sorted(CONFIG_DIR.glob("*.yaml")), ids=lambda p: p.name)
def test_no_shipped_config_combines_trainable_only_prefixes_with_a_freeze_flag(config_path):
    """train.py raises if trainable_only_prefixes AND freeze_encoder/freeze_token_embeddings are
    all set — pinned here at the config-sweep level so a future config can't ship the combination
    and only discover the raise at launch time."""
    raw = yaml.safe_load(config_path.read_text()) or {}
    train_section = raw.get("train") or {}
    has_prefixes = bool(train_section.get("trainable_only_prefixes"))
    has_freeze = bool(train_section.get("freeze_encoder")) or bool(train_section.get("freeze_token_embeddings"))
    assert not (has_prefixes and has_freeze), (
        f"{config_path.name} combines train.trainable_only_prefixes with a freeze_* flag — "
        "train.py raises ValueError on this combination (ambiguous lever attribution)"
    )
