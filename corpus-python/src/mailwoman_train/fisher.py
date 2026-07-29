"""Fisher capture + EWC consumption (v8.3.0 Phase 1 — the B11 consolidation artifact).

Design: docs/superpowers/plans/2026-07-30-fisher-capture-design.md. Two halves:

- :class:`FisherAccumulator` — the capture side. During the final N optimizer steps of a base run
  it accumulates the squared per-parameter gradient (the diagonal empirical Fisher
  ``F_i = E[(∂L/∂θ_i)²]``, estimated in the converged regime EWC's quadratic approximation
  assumes). It only ever READS ``p.grad`` — the training trajectory is byte-identical with the
  flag on or off (the rng/byte-stability rule every curriculum obeys; pinned by test). The
  artifact is ``fisher-diag-v1.npz`` (param name → fp32 array, state-dict keying) plus a
  ``fisher-diag-v1.json`` provenance sidecar — the lexicon discipline.

- :class:`EWCPenalty` — the consumption side (the fine-tune recipe template). Adds
  ``λ/2 · Σ F_i (θ_i − θ*_i)²`` to the loss against the base checkpoint ``θ*``. Parameters
  absent from the Fisher artifact (fresh heads) are unpenalized by construction — a fine-tune is
  free to LEARN new capability; the brake is on FORGETTING the base's. λ is calibrated once on
  our own next fine-tune (largest λ that leaves the increment's target within noise of λ=0) and
  becomes the template default.

The gradient is read at the accumulation boundary BEFORE clipping: the empirical Fisher is defined
on ∂L/∂θ, and the clipped surrogate would understate curvature exactly where it is largest.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch

FISHER_ARTIFACT = "fisher-diag-v1.npz"
FISHER_SIDECAR = "fisher-diag-v1.json"


class FisherAccumulator:
    """Running mean of squared gradients per parameter, fp32, on the parameters' device."""

    def __init__(self, model: torch.nn.Module) -> None:
        self._sums: dict[str, torch.Tensor] = {
            name: torch.zeros_like(p, dtype=torch.float32) for name, p in model.named_parameters() if p.requires_grad
        }
        self.count = 0

    @torch.no_grad()
    def accumulate(self, model: torch.nn.Module) -> None:
        """Read the current ``p.grad`` of every tracked parameter and add its square."""
        for name, p in model.named_parameters():
            if p.grad is None or name not in self._sums:
                continue
            self._sums[name] += p.grad.detach().to(torch.float32) ** 2
        self.count += 1

    def finalize(self) -> dict[str, np.ndarray]:
        if self.count == 0:
            raise RuntimeError("FisherAccumulator.finalize() with zero accumulated batches — capture window never ran")
        return {name: (s / self.count).cpu().numpy() for name, s in self._sums.items()}

    def save(self, out_dir: Path | str, meta: dict) -> Path:
        """Write ``fisher-diag-v1.npz`` + the provenance sidecar into ``out_dir``."""
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        arrays = self.finalize()
        path = out_dir / FISHER_ARTIFACT
        np.savez_compressed(path, **arrays)
        sidecar = {
            "version": "fisher-diag-v1",
            "kind": "diagonal-empirical-fisher",
            "count_batches": self.count,
            "param_count": int(sum(a.size for a in arrays.values())),
            **meta,
        }
        (out_dir / FISHER_SIDECAR).write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")
        return path


class EWCPenalty:
    """``λ/2 · Σ F_i (θ_i − θ*_i)²`` against a base checkpoint, computed in fp32.

    Keys present in BOTH the Fisher artifact and the reference state dict are penalized; anything
    else (fresh heads, resized rows) is skipped silently — that asymmetry is the design: new
    capability trains freely, base capability is braked.
    """

    def __init__(
        self,
        fisher_path: Path | str,
        reference_checkpoint: Path | str,
        *,
        lam: float,
        device: torch.device,
    ) -> None:
        self.lam = float(lam)
        with np.load(fisher_path) as z:
            fisher = {k: torch.from_numpy(z[k]).to(device=device, dtype=torch.float32) for k in z.files}
        ref_path = Path(reference_checkpoint)
        if ref_path.is_dir():
            ref_path = ref_path / "pytorch_model.bin"
        ref = torch.load(ref_path, map_location="cpu", weights_only=True)
        self._fisher: dict[str, torch.Tensor] = {}
        self._theta_star: dict[str, torch.Tensor] = {}
        for k, f in fisher.items():
            if k not in ref or tuple(ref[k].shape) != tuple(f.shape):
                continue
            self._fisher[k] = f
            self._theta_star[k] = ref[k].to(device=device, dtype=torch.float32)
        if not self._fisher:
            raise ValueError(f"EWC: no overlapping parameters between {fisher_path} and {reference_checkpoint}")
        self.covered_params = int(sum(f.numel() for f in self._fisher.values()))

    def penalty(self, model: torch.nn.Module) -> torch.Tensor:
        total: torch.Tensor | None = None
        for name, p in model.named_parameters():
            f = self._fisher.get(name)
            if f is None:
                continue
            term = (f * (p.to(torch.float32) - self._theta_star[name]) ** 2).sum()
            total = term if total is None else total + term
        if total is None:
            # A model that shares NO parameter names with the artifact is a wiring error (wrong
            # base, renamed modules) — silence here would ship an unbraked "protected" fine-tune.
            raise ValueError("EWC: model shares no parameter names with the Fisher artifact")
        return (self.lam / 2.0) * total
