"""Evidence curricula: what the model sees when the clue is wrong or missing.

Both curricula share one schedule — untouched until a quarter of the run, ramping to full by half,
then held — so a channel's basin forms before the noise starts arguing with it.

They teach different failures. The confidence perturbation teaches ABSENCE: a clue that sometimes
is not there, so the model keeps its competence without one. The evidence noise teaches FALSE
PRESENCE: a clue that is there and wrong, so the model treats painted evidence as a hint rather
than an instruction. Absence alone is what the v3.19/v3.20 golden-US verdicts showed to be
insufficient — in training, painted evidence was almost always truthful, so a street-type word
inside a street NAME still commanded the parse.
"""

from __future__ import annotations

import torch

# The model sees the full anchor early (break the German collapse, build the basin), then a ramped
# perturbation so it cannot launder the anchor. There is no discrete "no anchor" mode: absent is the
# c=0 tail of a continuum.
ANCHOR_CURRICULUM_START_FRAC = 0.25  # ≤ this fraction of max_steps: no perturbation
ANCHOR_CURRICULUM_RAMP_FRAC = 0.50  # by this fraction: full perturbation
ANCHOR_ZERO_OUT_MAX = 0.15  # peak per-row zero-out probability


def _ramp(step: int, max_steps: int) -> float | None:
    """How far into the curriculum this step is, or None while it has not started."""
    start = ANCHOR_CURRICULUM_START_FRAC * max_steps
    if step < start:
        return None
    span = (ANCHOR_CURRICULUM_RAMP_FRAC - ANCHOR_CURRICULUM_START_FRAC) * max_steps
    return min(1.0, (step - start) / max(1.0, span))


def perturb_anchor_confidence(conf: torch.Tensor, step: int, max_steps: int) -> torch.Tensor:
    """Curriculum-perturb the per-token anchor confidence ``(B, S)`` by training step.

    Per-token multiplicative noise α∼U(0.8,1.2) plus a per-ROW zero-out ramping to
    ANCHOR_ZERO_OUT_MAX. Per-row rather than per-token: an absent anchor has to stay absent across
    every sub-token of one postcode, or the row teaches a contradiction.
    """
    ramp = _ramp(step, max_steps)
    if ramp is None:
        return conf
    alpha = 0.8 + 0.4 * torch.rand_like(conf)  # per-token U(0.8, 1.2)
    out = (conf * alpha).clamp(0.0, 1.0)
    row_zero = (torch.rand(conf.shape[0], device=conf.device) < ANCHOR_ZERO_OUT_MAX * ramp).unsqueeze(1)
    return out.masked_fill(row_zero, 0.0)


def perturb_gazetteer_confidence(conf: torch.Tensor, step: int, max_steps: int) -> torch.Tensor:
    """The same curriculum on the gazetteer clue — the v0.9.12 fix.

    v0.9.12 lifted country, region and locality but cost US postcode 3.7 points, which is what
    leaning on an always-on clue looks like: the model reallocated base competence toward it.
    Dropping the clue on a growing fraction of rows forces it to keep that competence both with
    the hint and without.
    """
    return perturb_anchor_confidence(conf, step, max_steps)


def perturb_evidence_noise(
    features: torch.Tensor, conf: torch.Tensor, step: int, max_steps: int, p_noise: float
) -> tuple[torch.Tensor, torch.Tensor]:
    """Corrupt the painting while the LABELS stay gold, so the gradient teaches evidence-as-hint.

    With probability ``p_noise`` per row per channel:

    - a row that carries evidence has its (features, confidence) pair rolled by a random offset, so
      a real painted pattern lands on the wrong tokens — the collision shape;
    - an evidence-free row gets a synthetic one-token hit at a random position — a false positive
      on a clean row.
    """
    if p_noise <= 0.0:
        return features, conf
    ramp = _ramp(step, max_steps)
    if ramp is None:
        return features, conf
    bsz, seq = conf.shape
    noised = torch.rand(bsz, device=conf.device) < p_noise * ramp
    if not bool(noised.any()):
        return features, conf
    features = features.clone()
    conf = conf.clone()
    for i in torch.nonzero(noised).flatten().tolist():
        if bool((conf[i] > 0).any()):
            shift = int(torch.randint(1, seq, (1,), device=conf.device))
            features[i] = torch.roll(features[i], shift, dims=0)
            conf[i] = torch.roll(conf[i], shift, dims=0)
        else:
            pos = int(torch.randint(0, seq, (1,), device=conf.device))
            features[i, pos] = 1.0
            conf[i, pos] = 1.0
    return features, conf
