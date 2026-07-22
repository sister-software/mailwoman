"""Resume-path LR clobber (fork prep, options A/B): `optim.load_state_dict()` silently
overwrites every param-group's `lr`/`initial_lr` with the CHECKPOINT's saved values, discarding
whatever `build_optimizer` just built from the LIVE (possibly changed) config —
`scheduler.load_state_dict()` compounds this via `base_lrs`. See
`.superpowers/sdd/fork-implementation-notes.md` Q1/Q3/Q5#1 for the full trace.

`_restamp_resume_lrs` is the fix: re-apply the live config's LRs after both loads complete.
"""

from types import SimpleNamespace

import torch

from mailwoman_train.train import _build_scheduler, _restamp_resume_lrs, build_optimizer


class TinyModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = torch.nn.Linear(4, 4)
        self.classifier = torch.nn.Linear(4, 33)


class TinySpanClassifierModel(torch.nn.Module):
    """Adds a `span_scorer.` prefix so both carveouts (`span_head_learning_rate` AND
    `classifier_learning_rate`) can be exercised together — the 3-group shape."""

    def __init__(self):
        super().__init__()
        self.encoder = torch.nn.Linear(4, 4)
        self.span_scorer = torch.nn.Linear(4, 4)
        self.classifier = torch.nn.Linear(4, 33)


def _scheduler_cfg(*, warmup_steps=10, max_steps=100, lr_schedule="constant"):
    return SimpleNamespace(lr_schedule=lr_schedule, warmup_steps=warmup_steps, max_steps=max_steps)


def test_raw_load_state_dict_clobbers_a_changed_classifier_lr(tmp_path):
    """Trap characterization — NOT testing our fix. Proves the underlying torch behavior the
    fix exists to correct: a bare `build_optimizer` + `optim.load_state_dict()` round trip
    silently discards a changed `classifier_learning_rate`, with no exception and no signal."""
    # Phase-1 "checkpoint": classifier group at the old hot LR.
    m1 = TinyModel()
    optim1, _labels1 = build_optimizer(m1, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)
    opt_state_path = tmp_path / "optimizer.pt"
    torch.save(optim1.state_dict(), opt_state_path)

    # Phase-2 "resume": build fresh from a DIFFERENT (decayed) classifier LR, per config.
    m2 = TinyModel()
    optim2, _labels2 = build_optimizer(m2, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-4)
    live_classifier_lr = next(g["lr"] for g in optim2.param_groups if g["lr"] == 1e-4)
    assert live_classifier_lr == 1e-4  # sanity: the fresh build DID honor the new config

    optim2.load_state_dict(torch.load(opt_state_path, weights_only=False))

    # The trap: post-load, the group is back at the CHECKPOINT's old LR, not the live config's.
    # Both groups have 2 params (weight+bias) — disambiguate by numel (classifier: 33*4+33).
    classifier_group = next(g for g in optim2.param_groups if sum(p.numel() for p in g["params"]) == 33 * 4 + 33)
    assert classifier_group["lr"] == 1e-3  # old value won — silently
    assert classifier_group["lr"] != 1e-4  # the live config's value never survived the load


def test_restamp_resume_lrs_recovers_the_live_config_value(tmp_path, capsys):
    """With the fix applied: after `_restamp_resume_lrs`, param groups AND scheduler.base_lrs
    reflect the live config's (changed) classifier LR, not the checkpoint's."""
    m1 = TinyModel()
    optim1, _labels1 = build_optimizer(m1, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)
    sched1 = _build_scheduler(optim1, _scheduler_cfg(warmup_steps=2))
    # Advance past warmup so the "checkpoint" reflects a real mid-training save (constant-post-
    # warmup LR), not the scheduler's step-0 zeroed value — a real checkpoint is always saved
    # after some training has happened.
    for _ in range(5):
        sched1.step()
    opt_state_path = tmp_path / "optimizer.pt"
    sched_state_path = tmp_path / "scheduler.pt"
    torch.save(optim1.state_dict(), opt_state_path)
    torch.save(sched1.state_dict(), sched_state_path)

    m2 = TinyModel()
    # `labels` is build_optimizer's OWN return, not a hand-typed parallel list — the point of
    # this fix. See `test_restamp_resume_lrs_labels_are_not_a_hand_built_list` below for the
    # reorder-proofing assertion this buys.
    optim2, labels = build_optimizer(m2, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-4)
    live_lrs = [g["lr"] for g in optim2.param_groups]
    sched2 = _build_scheduler(optim2, _scheduler_cfg(warmup_steps=2))

    optim2.load_state_dict(torch.load(opt_state_path, weights_only=False))
    sched2.load_state_dict(torch.load(sched_state_path, weights_only=False))

    # Pre-fix sanity: both loads clobbered the live value back to the checkpoint's.
    # Both groups have 2 params (weight+bias) — disambiguate by numel (classifier: 33*4+33,
    # base/encoder: 4*4+4).
    def _classifier_group(optim):
        return next(g for g in optim.param_groups if sum(p.numel() for p in g["params"]) == 33 * 4 + 33)

    def _base_group(optim):
        return next(g for g in optim.param_groups if sum(p.numel() for p in g["params"]) == 4 * 4 + 4)

    assert _classifier_group(optim2)["lr"] == 1e-3

    capsys.readouterr()  # discard build_optimizer's own [classifier_learning_rate] prints
    _restamp_resume_lrs(optim2, sched2, live_lrs, labels)
    out = capsys.readouterr().out

    classifier_group = _classifier_group(optim2)
    base_group = _base_group(optim2)
    assert classifier_group["lr"] == 1e-4
    assert classifier_group["initial_lr"] == 1e-4
    assert sched2.base_lrs == [1e-5, 1e-4]
    assert base_group["lr"] == 1e-5  # unchanged group stays unchanged

    assert "[resume-lr] group 1 (classifier_learning_rate): checkpoint 0.001 -> config 0.0001" in out
    assert "group 0 (base)" not in out  # base group's LR never changed — no line for it


def test_restamp_resume_lrs_is_silent_when_nothing_changed(tmp_path, capsys):
    """Identical-config resume: state round-trips, param groups end up byte-equal, and
    `_restamp_resume_lrs` prints nothing (the silent no-op path)."""
    m1 = TinyModel()
    optim1, _labels1 = build_optimizer(m1, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)
    sched1 = _build_scheduler(optim1, _scheduler_cfg(warmup_steps=2))
    for _ in range(5):  # past warmup — see the sibling test's comment for why this matters
        sched1.step()
    opt_state_path = tmp_path / "optimizer.pt"
    sched_state_path = tmp_path / "scheduler.pt"
    torch.save(optim1.state_dict(), opt_state_path)
    torch.save(sched1.state_dict(), sched_state_path)

    m2 = TinyModel()
    # SAME classifier_learning_rate as phase 1 — nothing should change on restamp.
    optim2, labels = build_optimizer(m2, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)
    live_lrs = [g["lr"] for g in optim2.param_groups]
    sched2 = _build_scheduler(optim2, _scheduler_cfg(warmup_steps=2))

    optim2.load_state_dict(torch.load(opt_state_path, weights_only=False))
    sched2.load_state_dict(torch.load(sched_state_path, weights_only=False))

    before = [dict(g) for g in optim2.param_groups]
    before_lrs = [g["lr"] for g in before]
    before_initial_lrs = [g.get("initial_lr") for g in before]

    capsys.readouterr()
    _restamp_resume_lrs(optim2, sched2, live_lrs, labels)
    out = capsys.readouterr().out

    assert out == ""  # byte-identical silent path: nothing changed, nothing printed
    after_lrs = [g["lr"] for g in optim2.param_groups]
    after_initial_lrs = [g.get("initial_lr") for g in optim2.param_groups]
    assert after_lrs == before_lrs
    assert after_initial_lrs == before_initial_lrs
    assert sched2.base_lrs == live_lrs


def test_build_optimizer_three_group_labels_attribute_to_the_right_group(tmp_path, capsys):
    """span_head_learning_rate AND classifier_learning_rate both set — 3 groups. Labels must
    attribute to the group that actually carries that override's LR, not just be the right
    length/set of strings (the original bug: the caller's hand-built if-chain could get the
    STRINGS right while attributing them to the wrong `optim.param_groups` index after a
    build_optimizer reorder). Then runs the full resume round trip through `_restamp_resume_lrs`
    to confirm the labels survive into the `[resume-lr]` print correctly per group.
    """
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

    # Attribution check: each label's group must hold that override's PARAMS, not just its LR
    # (a positional-only check could pass by coincidence if two overrides shared an LR value).
    expected_params_by_label = {
        "base": {id(p) for n, p in m1.named_parameters() if n.startswith("encoder.")},
        "span_head_learning_rate": {id(p) for n, p in m1.named_parameters() if n.startswith("span_scorer.")},
        "classifier_learning_rate": {id(p) for n, p in m1.named_parameters() if n.startswith("classifier.")},
    }
    for label, group in zip(labels1, optim1.param_groups, strict=True):
        assert {id(p) for p in group["params"]} == expected_params_by_label[label]

    sched1 = _build_scheduler(optim1, _scheduler_cfg(warmup_steps=2))
    for _ in range(5):
        sched1.step()
    opt_state_path = tmp_path / "optimizer.pt"
    sched_state_path = tmp_path / "scheduler.pt"
    torch.save(optim1.state_dict(), opt_state_path)
    torch.save(sched1.state_dict(), sched_state_path)

    m2 = TinySpanClassifierModel()
    # Decayed span_head + classifier LRs, per a live config change across the resume.
    optim2, labels2 = build_optimizer(
        m2,
        learning_rate=1e-5,
        weight_decay=0.01,
        span_head_learning_rate=1e-4,
        classifier_learning_rate=1e-3,
    )
    # Reorder-proofing: `labels2` is READ from build_optimizer's return, never re-derived by
    # this test — the same discipline the fixed call site in train.py now follows. If
    # build_optimizer's internal carve-out order ever changes, this assignment (and the
    # zip below) tracks it automatically; nothing here hard-codes group index -> label.
    assert labels2 == labels1  # same overrides set => same label order, sourced fresh each time
    live_lrs = [g["lr"] for g in optim2.param_groups]
    sched2 = _build_scheduler(optim2, _scheduler_cfg(warmup_steps=2))

    optim2.load_state_dict(torch.load(opt_state_path, weights_only=False))
    sched2.load_state_dict(torch.load(sched_state_path, weights_only=False))

    capsys.readouterr()
    _restamp_resume_lrs(optim2, sched2, live_lrs, labels2)
    out = capsys.readouterr().out

    for _label, group, live_lr in zip(labels2, optim2.param_groups, live_lrs, strict=True):
        assert group["lr"] == live_lr
    assert "[resume-lr] group 1 (span_head_learning_rate): checkpoint 0.001 -> config 0.0001" in out
    assert "[resume-lr] group 2 (classifier_learning_rate): checkpoint 0.01 -> config 0.001" in out
    assert "group 0 (base)" not in out  # base group's LR never changed — no line for it
