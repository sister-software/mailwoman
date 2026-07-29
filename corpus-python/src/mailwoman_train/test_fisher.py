"""Fisher capture + EWC consumption (v8.3.0 Phase 1 — fisher.py).

Pins the three contract properties the design memo names:

1. **Byte-identical trajectory** — capture only reads ``p.grad``; a run with the accumulator
   attached ends with exactly the weights of a run without it (the rng/byte-stability rule).
2. **The accumulator computes what it claims** — the mean of squared gradients, keyed like the
   state dict, saved as npz + provenance sidecar, and loud on a zero-count finalize.
3. **The EWC brake behaves at its limits** — zero penalty at θ = θ*, λ=0 leaves the loss
   untouched, a huge λ pins the model to the reference, and fresh-head params (absent from the
   Fisher artifact) train freely.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")  # training deps (torch) aren't installed in lint-only envs

import numpy as np  # noqa: E402

from mailwoman_train.fisher import FISHER_ARTIFACT, FISHER_SIDECAR, EWCPenalty, FisherAccumulator  # noqa: E402


def _tiny(seed: int = 0) -> torch.nn.Sequential:
    torch.manual_seed(seed)
    return torch.nn.Sequential(torch.nn.Linear(4, 8), torch.nn.ReLU(), torch.nn.Linear(8, 3))


def _train_steps(model: torch.nn.Module, n: int, accumulator: FisherAccumulator | None = None) -> None:
    torch.manual_seed(123)
    optim = torch.optim.SGD(model.parameters(), lr=0.05)
    for _ in range(n):
        x = torch.randn(16, 4)
        y = torch.randint(0, 3, (16,))
        optim.zero_grad(set_to_none=True)
        loss = torch.nn.functional.cross_entropy(model(x), y)
        loss.backward()
        if accumulator is not None:
            accumulator.accumulate(model)
        optim.step()


def test_capture_does_not_perturb_the_trajectory() -> None:
    plain = _tiny()
    _train_steps(plain, 20)
    captured = _tiny()
    acc = FisherAccumulator(captured)
    _train_steps(captured, 20, accumulator=acc)
    for (ka, a), (kb, b) in zip(plain.state_dict().items(), captured.state_dict().items(), strict=True):
        assert ka == kb
        assert torch.equal(a, b), f"trajectory diverged at {ka}"
    assert acc.count == 20


def test_accumulator_is_the_mean_of_squared_grads() -> None:
    model = _tiny()
    acc = FisherAccumulator(model)
    manual = {name: torch.zeros_like(p) for name, p in model.named_parameters()}
    torch.manual_seed(7)
    for _ in range(5):
        x = torch.randn(8, 4)
        y = torch.randint(0, 3, (8,))
        for p in model.parameters():
            p.grad = None
        torch.nn.functional.cross_entropy(model(x), y).backward()
        for name, p in model.named_parameters():
            manual[name] += p.grad.detach() ** 2
        acc.accumulate(model)
    fisher = acc.finalize()
    for name, want in manual.items():
        got = torch.from_numpy(fisher[name])
        assert torch.allclose(got, want / 5, atol=1e-7), name
        assert (got >= 0).all()


def test_save_writes_artifact_and_sidecar(tmp_path: Path) -> None:
    model = _tiny()
    acc = FisherAccumulator(model)
    _train_steps(model, 3, accumulator=acc)
    out = acc.save(tmp_path, meta={"captured_at_step": 3, "seed": 42})
    assert out == tmp_path / FISHER_ARTIFACT
    with np.load(out) as z:
        assert set(z.files) == {n for n, _ in model.named_parameters()}
    sidecar = json.loads((tmp_path / FISHER_SIDECAR).read_text())
    assert sidecar["version"] == "fisher-diag-v1"
    assert sidecar["count_batches"] == 3
    assert sidecar["captured_at_step"] == 3
    assert sidecar["param_count"] == sum(p.numel() for p in model.parameters())


def test_zero_count_finalize_raises() -> None:
    with pytest.raises(RuntimeError, match="zero accumulated batches"):
        FisherAccumulator(_tiny()).finalize()


def _fisher_and_reference(tmp_path: Path) -> tuple[Path, Path, torch.nn.Module]:
    base = _tiny(seed=1)
    acc = FisherAccumulator(base)
    _train_steps(base, 10, accumulator=acc)
    acc.save(tmp_path, meta={})
    ref = tmp_path / "pytorch_model.bin"
    torch.save(base.state_dict(), ref)
    return tmp_path / FISHER_ARTIFACT, ref, base


def test_ewc_penalty_is_zero_at_the_reference(tmp_path: Path) -> None:
    fisher_path, ref, base = _fisher_and_reference(tmp_path)
    ewc = EWCPenalty(fisher_path, ref, lam=1e4, device=torch.device("cpu"))
    assert float(ewc.penalty(base)) == 0.0


def test_ewc_penalty_grows_with_distance_and_scales_with_lambda(tmp_path: Path) -> None:
    fisher_path, ref, base = _fisher_and_reference(tmp_path)
    moved = _tiny(seed=1)
    moved.load_state_dict(base.state_dict())
    with torch.no_grad():
        for p in moved.parameters():
            p += 0.1
    p1 = float(EWCPenalty(fisher_path, ref, lam=1.0, device=torch.device("cpu")).penalty(moved))
    p2 = float(EWCPenalty(fisher_path, ref, lam=2.0, device=torch.device("cpu")).penalty(moved))
    assert p1 > 0.0
    assert p2 == pytest.approx(2 * p1, rel=1e-6)


def _fisher_weighted_drift(fisher_path: Path, base: torch.nn.Module, tuned: torch.nn.Module) -> float:
    """Σ F_i·(θ_i − θ*_i)² — drift measured where the Fisher says the base had curvature.

    EWC only promises protection ALONG high-Fisher directions; low-curvature directions drift
    freely by design (that freedom is what lets the fine-tune learn). An unweighted drift metric
    counts exactly the directions the brake deliberately releases.
    """
    base_sd = base.state_dict()
    total = 0.0
    with np.load(fisher_path) as z:
        for name, p in tuned.state_dict().items():
            if name in z.files:
                total += float((torch.from_numpy(z[name]) * (p - base_sd[name]) ** 2).sum())
    return total


def test_large_lambda_brakes_the_drift(tmp_path: Path) -> None:
    """A braked fine-tune stays far closer to the base — in Fisher-weighted distance — than an
    unbraked twin on the same stream.

    (λ is bounded by SGD stability — λ·F·lr must stay < 2 — so the memo's "λ→∞ freezes" is asserted
    as a strong RELATIVE brake at a large-but-stable λ, not a literal fixed point.)
    """

    def tune(lam: float) -> torch.nn.Module:
        fisher_path, ref, base = _fisher_and_reference(tmp_path)
        tuned = _tiny(seed=1)
        tuned.load_state_dict(base.state_dict())
        ewc = EWCPenalty(fisher_path, ref, lam=lam, device=torch.device("cpu")) if lam else None
        optim = torch.optim.SGD(tuned.parameters(), lr=0.01)
        torch.manual_seed(9)
        for _ in range(30):
            x = torch.randn(16, 4)
            y = torch.randint(0, 3, (16,))
            optim.zero_grad(set_to_none=True)
            loss = torch.nn.functional.cross_entropy(tuned(x), y)
            if ewc is not None:
                loss = loss + ewc.penalty(tuned)
            loss.backward()
            optim.step()
        for p in tuned.parameters():
            assert torch.isfinite(p).all()
        return tuned

    fisher_path, _, base = _fisher_and_reference(tmp_path)
    drift_free = _fisher_weighted_drift(fisher_path, base, tune(0.0))
    drift_braked = _fisher_weighted_drift(fisher_path, base, tune(1000.0))
    assert drift_free > 0.0
    assert drift_braked < 0.2 * drift_free, f"brake too weak: {drift_braked:.6f} vs free {drift_free:.6f}"


def test_fresh_head_params_are_unpenalized(tmp_path: Path) -> None:
    fisher_path, ref, base = _fisher_and_reference(tmp_path)

    class WithHead(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.body = base  # prefixes every name with "body." — zero overlap with the artifact
            self.fresh_head = torch.nn.Linear(3, 5)

    # A model sharing NO names with the artifact is a wiring error — penalty() refuses loudly
    # (silence would ship an unbraked "protected" fine-tune).
    ewc = EWCPenalty(fisher_path, ref, lam=1.0, device=torch.device("cpu"))
    with pytest.raises(ValueError, match="no parameter names"):
        ewc.penalty(WithHead())

    # The realistic shape: same names, one EXTRA fresh param. Penalty must ignore the extra.
    tuned = _tiny(seed=1)
    tuned.load_state_dict(base.state_dict())
    baseline = float(ewc.penalty(tuned))
    tuned.fresh = torch.nn.Linear(3, 5)  # registers a new named parameter pair
    with torch.no_grad():
        tuned.fresh.weight += 10.0
    assert float(ewc.penalty(tuned)) == pytest.approx(baseline)
