"""The anchor-confidence robustness curriculum (#239/#240)."""

from __future__ import annotations

import torch

from mailwoman_train.train.noise import perturb_anchor_confidence


def test_confidence_curriculum_no_op_early_perturbs_late() -> None:
    """The curriculum is a no-op before 25% of max_steps, then perturbs downward and zeros whole rows.

    It never raises a confidence above 1.0, and it never switches to a discrete regime.
    """
    conf = torch.ones(128, 6)
    assert torch.equal(perturb_anchor_confidence(conf, 0, 20000), conf)  # 0% → untouched
    assert torch.equal(perturb_anchor_confidence(conf, 4999, 20000), conf)  # <25% → untouched
    torch.manual_seed(0)
    late = perturb_anchor_confidence(conf, 15000, 20000)  # >50% → full perturbation
    assert not torch.equal(late, conf)
    assert float(late.max()) <= 1.0 and float(late.min()) >= 0.0
    zeroed_rows = int((late.sum(dim=1) == 0).sum().item())
    assert 0 < zeroed_rows < 128  # some rows fully zeroed (anchor "absent"), not all
