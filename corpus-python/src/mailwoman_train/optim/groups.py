"""Parameter groups, and the classifier-row reset a dead tag needs.

Both exist for the same reason: a freshly initialized part of an otherwise pretrained model cannot
learn at the encoder's fine-tuning rate. A carved-out group gives that part its own rate, and a
re-initialized output row gives a dead tag somewhere to learn from.
"""

from __future__ import annotations

from typing import Any

import torch
from torch.optim import AdamW

from ..labels import LABEL_TO_ID


def build_optimizer(
    model: Any,
    *,
    learning_rate: float,
    weight_decay: float,
    span_head_learning_rate: float | None = None,
    classifier_learning_rate: float | None = None,
) -> tuple[AdamW, list[str]]:
    """AdamW over the model's trainable parameters, with optional faster rates for named parts.

    A part of the model that starts from random weights needs a much higher learning rate than one
    that is being fine-tuned. Running both at the encoder's rate leaves the new part barely moving:
    the span head at 1e-5 went from loss 26.4 to 17.8 over 2,000 steps and was still falling, with
    span NLL around 35 where a converged one sits near 1. Each override puts its parameters in
    their own group at their own rate, typically 1e-3 against the encoder's 1e-5.

    `span_head_learning_rate` covers the span scorer. `classifier_learning_rate` covers the output
    head, plus the separate dependent-locality head and the street-type and locality-surface input
    channels, which are all fresh for the same reason.

    Schedules compose for free: LambdaLR scales each group's own base rate by the same multiplier,
    so every group keeps its shape and the ratios between them hold.

    Frozen parameters are excluded. With no overrides there is one group, identical to what every
    earlier recipe produced. The base group is dropped when a run freezes everything outside a
    carve-out and nothing is left for it.

    Returns the optimizer and a list naming each group, in order. The names come back as a return
    value rather than being stored on the groups themselves because loading a checkpoint replaces
    each group's contents wholesale — a name stored there would vanish when resuming from a
    checkpoint written before the name existed. A resume needs these names to report which group's
    rate it restamped, so they must survive that load.
    """
    trainable = [(n, p) for n, p in model.named_parameters() if p.requires_grad]

    carveouts: list[tuple[tuple[str, ...], float, str]] = []
    if span_head_learning_rate is not None:
        carveouts.append((("span_scorer.", "semi_crf."), span_head_learning_rate, "span_head_learning_rate"))
    if classifier_learning_rate is not None:
        # deploc_head rides the classifier carveout: it is the output head for dependent_locality,
        # so the fresh head resurrects at the same hot LR the reinitialized classifier rows use —
        # one variable under test (separate head versus flat-head reinit), same rate. The
        # street-type and locality-surface projections ride it for the same reason: a fresh input
        # channel needs the hot rate to learn to use its signal within a short probe, while the
        # encoder fine-tunes at the base rate. Every extra prefix is a no-op when its module is
        # off, because `classifier.` still matches and the group is never empty.
        carveouts.append(
            (
                (
                    "classifier.",
                    "deploc_head.",
                    "street_type_projection.",
                    "street_type_token_embedding",
                    "locality_surface_projection.",
                    "locality_surface_token_embedding",
                ),
                classifier_learning_rate,
                "classifier_learning_rate",
            )
        )

    if not carveouts:
        optim = AdamW([p for _, p in trainable], lr=learning_rate, weight_decay=weight_decay)
        return optim, ["base"]

    groups = []
    labels = []
    rest = trainable
    for prefixes, lr, key in carveouts:
        head = [p for n, p in rest if n.startswith(prefixes)]
        rest = [(n, p) for n, p in rest if not n.startswith(prefixes)]
        if not head:
            raise RuntimeError(
                f"train.{key} is set but no params match prefixes {prefixes} — "
                "check the model config enables the corresponding module, or drop the override"
            )
        print(f"[{key}] {sum(p.numel() for p in head):,} params @ {lr}")
        groups.append({"params": head, "lr": lr})
        labels.append(key)

    if rest:
        groups.insert(0, {"params": [p for _, p in rest], "lr": learning_rate})
        labels.insert(0, "base")
    return AdamW(groups, lr=learning_rate, weight_decay=weight_decay), labels


def reinit_label_rows(model: Any, labels: list[str]) -> None:
    """Reset the named BIO labels' classifier rows to the mean of the LIVE rows.

    The dead-tag mechanism: initializing from a checkpoint where a tag never fires leaves its
    output row deeply negative, and class weights only scale a vanishing gradient (v382 and v383
    were both no-ops). Mean-of-live re-init puts the row back on the decision surface, where the
    resurrection rate can steer it.
    """
    rows = [LABEL_TO_ID[label] for label in labels]
    with torch.no_grad():
        live = [i for i in range(model.classifier.out_features) if i not in rows]
        mean_w = model.classifier.weight[live].mean(dim=0)
        mean_b = model.classifier.bias[live].mean()
        for i in rows:
            model.classifier.weight[i] = mean_w
            model.classifier.bias[i] = mean_b
    print(f"[reinit_label_rows] rows {rows} ← live-row mean ({labels})")
