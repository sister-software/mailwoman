"""Dead-tag resurrection levers (#456/#1100): reinit_label_rows + classifier_learning_rate.

Adam's update is gradient-scale-invariant, so a gradient hook on rows 7/8 cannot create an
effective per-row LR — the carve-out must be a real param group over the whole classifier
tensor (mirrors the shipped `span_head_learning_rate` mechanism). Row-level precision comes
from `reinit_label_rows` resetting only the named rows to the live-row mean.
"""

import torch

from mailwoman_train.labels import LABEL_TO_ID
from mailwoman_train.train import build_optimizer, reinit_label_rows


class TinyModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = torch.nn.Linear(4, 4)
        self.classifier = torch.nn.Linear(4, 33)


def test_classifier_learning_rate_makes_two_groups():
    m = TinyModel()
    optim, labels = build_optimizer(m, learning_rate=1e-5, weight_decay=0.01, classifier_learning_rate=1e-3)
    lrs = sorted(g["lr"] for g in optim.param_groups)
    assert lrs == [1e-5, 1e-3]
    hot = next(g for g in optim.param_groups if g["lr"] == 1e-3)
    assert sum(p.numel() for p in hot["params"]) == 33 * 4 + 33  # classifier.weight + bias only
    assert labels == ["base", "classifier_learning_rate"]


def test_no_override_is_single_group():
    m = TinyModel()
    optim, labels = build_optimizer(m, learning_rate=1e-5, weight_decay=0.01)
    assert len(optim.param_groups) == 1
    assert labels == ["base"]


def test_reinit_label_rows_resets_only_named_rows():
    m = TinyModel()
    with torch.no_grad():
        m.classifier.weight.fill_(0.0)
        m.classifier.bias.fill_(0.0)
        m.classifier.weight[7].fill_(-9.0)  # B-dependent_locality, the baked-dead row
        m.classifier.bias[7] = -9.0
    before = m.classifier.weight.clone()
    reinit_label_rows(m, ["B-dependent_locality", "I-dependent_locality"])
    idx_b = LABEL_TO_ID["B-dependent_locality"]
    assert idx_b == 7
    # Reset rows equal the live-row mean (0.0 here), untouched rows unchanged.
    assert torch.allclose(m.classifier.weight[7], torch.zeros(4))
    assert float(m.classifier.bias[7]) == 0.0
    live = [i for i in range(33) if i not in (7, 8)]
    assert torch.equal(m.classifier.weight[live], before[live])
