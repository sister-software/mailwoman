"""`optim.load_state_dict()` overwrites every param group's `lr`/`initial_lr` with the checkpoint's saved values and `scheduler.load_state_dict()` does the same to `base_lrs`, so `restamp_resume_lrs` re-applies the live config's LRs after both loads complete."""

from types import SimpleNamespace

import torch

from mailwoman_train.optim.groups import build_optimizer
from mailwoman_train.optim.schedules import build_scheduler, restamp_resume_lrs


class TinyModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = torch.nn.Linear(4, 4)
        self.classifier = torch.nn.Linear(4, 33)


class TinySpanClassifierModel(torch.nn.Module):
    """Adds a `span_scorer.` prefix so both carve-outs (`span_head_learning_rate` and `classifier_learning_rate`) can be exercised together."""

    def __init__(self):
        super().__init__()
        self.encoder = torch.nn.Linear(4, 4)
        self.span_scorer = torch.nn.Linear(4, 4)
        self.classifier = torch.nn.Linear(4, 33)


def _scheduler_cfg(*, warmup_steps=10, max_steps=100, lr_schedule="constant"):
    return SimpleNamespace(lr_schedule=lr_schedule, warmup_steps=warmup_steps, max_steps=max_steps)


def test_raw_load_state_dict_clobbers_a_changed_classifier_lr(tmp_path):
    """Not testing our fix: a bare `build_optimizer` + `optim.load_state_dict()` round trip silently discards a changed `classifier_learning_rate`, with no exception and no signal."""
    m1 = TinyModel()
    optim1, _labels1 = build_optimizer(m1, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)
    opt_state_path = tmp_path / "optimizer.pt"
    torch.save(optim1.state_dict(), opt_state_path)

    m2 = TinyModel()
    optim2, _labels2 = build_optimizer(m2, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-4)
    live_classifier_lr = next(g["lr"] for g in optim2.param_groups if g["lr"] == 1e-4)
    assert live_classifier_lr == 1e-4

    optim2.load_state_dict(torch.load(opt_state_path, weights_only=False))

    # Post-load the group holds the checkpoint's LR; both groups have 2 params, so disambiguate by numel.
    classifier_group = next(g for g in optim2.param_groups if sum(p.numel() for p in g["params"]) == 33 * 4 + 33)
    assert classifier_group["lr"] == 1e-3
    assert classifier_group["lr"] != 1e-4


def test_restamp_resume_lrs_recovers_the_live_config_value(tmp_path, capsys):
    """After `restamp_resume_lrs`, param groups and `scheduler.base_lrs` reflect the live config's changed classifier LR rather than the checkpoint's."""
    m1 = TinyModel()
    optim1, _labels1 = build_optimizer(m1, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)
    sched1 = build_scheduler(optim1, _scheduler_cfg(warmup_steps=2))
    # Advance past warmup: a real checkpoint is saved mid-training, not at the scheduler's step-0
    # zeroed value.
    for _ in range(5):
        sched1.step()
    opt_state_path = tmp_path / "optimizer.pt"
    sched_state_path = tmp_path / "scheduler.pt"
    torch.save(optim1.state_dict(), opt_state_path)
    torch.save(sched1.state_dict(), sched_state_path)

    m2 = TinyModel()
    optim2, labels = build_optimizer(m2, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-4)
    live_lrs = [g["lr"] for g in optim2.param_groups]
    sched2 = build_scheduler(optim2, _scheduler_cfg(warmup_steps=2))

    optim2.load_state_dict(torch.load(opt_state_path, weights_only=False))
    sched2.load_state_dict(torch.load(sched_state_path, weights_only=False))

    def _classifier_group(optim):
        return next(g for g in optim.param_groups if sum(p.numel() for p in g["params"]) == 33 * 4 + 33)

    def _base_group(optim):
        return next(g for g in optim.param_groups if sum(p.numel() for p in g["params"]) == 4 * 4 + 4)

    assert _classifier_group(optim2)["lr"] == 1e-3

    capsys.readouterr()  # discard build_optimizer's own [classifier_learning_rate] prints
    restamp_resume_lrs(optim2, sched2, live_lrs, labels)
    out = capsys.readouterr().out

    classifier_group = _classifier_group(optim2)
    base_group = _base_group(optim2)
    assert classifier_group["lr"] == 1e-4
    assert classifier_group["initial_lr"] == 1e-4
    assert sched2.base_lrs == [1e-5, 1e-4]
    assert base_group["lr"] == 1e-5

    assert "[resume-lr] group 1 (classifier_learning_rate): checkpoint 0.001 -> config 0.0001" in out
    assert "group 0 (base)" not in out


def test_restamp_resume_lrs_is_silent_when_nothing_changed(tmp_path, capsys):
    """Identical-config resume: state round-trips, param groups end up byte-equal, and `restamp_resume_lrs` prints no line."""
    m1 = TinyModel()
    optim1, _labels1 = build_optimizer(m1, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)
    sched1 = build_scheduler(optim1, _scheduler_cfg(warmup_steps=2))
    for _ in range(5):
        sched1.step()
    opt_state_path = tmp_path / "optimizer.pt"
    sched_state_path = tmp_path / "scheduler.pt"
    torch.save(optim1.state_dict(), opt_state_path)
    torch.save(sched1.state_dict(), sched_state_path)

    m2 = TinyModel()
    optim2, labels = build_optimizer(m2, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)
    live_lrs = [g["lr"] for g in optim2.param_groups]
    sched2 = build_scheduler(optim2, _scheduler_cfg(warmup_steps=2))

    optim2.load_state_dict(torch.load(opt_state_path, weights_only=False))
    sched2.load_state_dict(torch.load(sched_state_path, weights_only=False))

    before = [dict(g) for g in optim2.param_groups]
    before_lrs = [g["lr"] for g in before]
    before_initial_lrs = [g.get("initial_lr") for g in before]

    capsys.readouterr()
    restamp_resume_lrs(optim2, sched2, live_lrs, labels)
    out = capsys.readouterr().out

    assert out == ""
    after_lrs = [g["lr"] for g in optim2.param_groups]
    after_initial_lrs = [g.get("initial_lr") for g in optim2.param_groups]
    assert after_lrs == before_lrs
    assert after_initial_lrs == before_initial_lrs
    assert sched2.base_lrs == live_lrs


def test_build_optimizer_three_group_labels_attribute_to_the_right_group(tmp_path, capsys):
    """With both override LRs set there are 3 groups, and each label must attribute to the group that carries its override rather than merely be the right string."""
    m1 = TinySpanClassifierModel()
    optim1, labels1 = build_optimizer(
        m1,
        learning_rate=1e-5,
        weight_decay=0.01,
        span_head_learning_rate=1e-3,
        classifier_learning_rate=1e-2,
    )
    assert len(optim1.param_groups) == 3
    assert labels1 == ["base", "span_head_learning_rate", "classifier_learning_rate"]

    # Each label's group must hold that override's params, not merely the right LR, which a
    # positional check could pass by coincidence.
    expected_params_by_label = {
        "base": {id(p) for n, p in m1.named_parameters() if n.startswith("encoder.")},
        "span_head_learning_rate": {id(p) for n, p in m1.named_parameters() if n.startswith("span_scorer.")},
        "classifier_learning_rate": {id(p) for n, p in m1.named_parameters() if n.startswith("classifier.")},
    }
    for label, group in zip(labels1, optim1.param_groups, strict=True):
        assert {id(p) for p in group["params"]} == expected_params_by_label[label]

    sched1 = build_scheduler(optim1, _scheduler_cfg(warmup_steps=2))
    for _ in range(5):
        sched1.step()
    opt_state_path = tmp_path / "optimizer.pt"
    sched_state_path = tmp_path / "scheduler.pt"
    torch.save(optim1.state_dict(), opt_state_path)
    torch.save(sched1.state_dict(), sched_state_path)

    m2 = TinySpanClassifierModel()
    optim2, labels2 = build_optimizer(
        m2,
        learning_rate=1e-5,
        weight_decay=0.01,
        span_head_learning_rate=1e-4,
        classifier_learning_rate=1e-3,
    )
    # `labels2` is build_optimizer's return, never re-derived here, so a carve-out reorder is
    # tracked automatically.
    assert labels2 == labels1
    live_lrs = [g["lr"] for g in optim2.param_groups]
    sched2 = build_scheduler(optim2, _scheduler_cfg(warmup_steps=2))

    optim2.load_state_dict(torch.load(opt_state_path, weights_only=False))
    sched2.load_state_dict(torch.load(sched_state_path, weights_only=False))

    capsys.readouterr()
    restamp_resume_lrs(optim2, sched2, live_lrs, labels2)
    out = capsys.readouterr().out

    for _label, group, live_lr in zip(labels2, optim2.param_groups, live_lrs, strict=True):
        assert group["lr"] == live_lr
    assert "[resume-lr] group 1 (span_head_learning_rate): checkpoint 0.001 -> config 0.0001" in out
    assert "[resume-lr] group 2 (classifier_learning_rate): checkpoint 0.01 -> config 0.001" in out
    assert "group 0 (base)" not in out
