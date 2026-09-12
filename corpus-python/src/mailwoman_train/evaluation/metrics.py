"""Token-level scores read during a run, and the CSV row they are logged as.

Both metrics here take the same position on absent evidence: a tag the validation sample does not
contain has an UNDEFINED score, not a zero. `token_f1` excludes it from the macro average and
`eval_csv_row` writes an empty cell, so a chart draws a gap. A flat zero would read as a model that
cannot label the tag rather than a sample that never asked it to.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

import torch

from ..labels import ACTIVE_BIO_LABELS, ID_TO_LOCALE, IGNORE_INDEX, LABEL_TO_ID


def token_f1(
    preds: torch.Tensor,
    labels: torch.Tensor,
    num_labels: int,
    bio_labels: tuple[str, ...] = ACTIVE_BIO_LABELS,
) -> dict[str, float]:
    """Macro and per-class token-level F1 over a batch, ignoring ``IGNORE_INDEX`` positions.

    Returns ``macro_f1`` plus per-BIO-label F1 (``f1.B-locality``, …), collapsed per-tag F1
    (``f1_tag.locality`` = (B + I) / 2) and per-tag support. The per-tag columns are what the CSV
    log and dashboard read; the per-BIO ones are for debugging.

    ``macro_f1`` averages only component labels with support above zero, and excludes ``O``. A
    zero-support tag would otherwise pin F1 at 0 and drag the macro down, which measures validation
    coverage rather than the model; ``O``'s huge support and near-1.0 F1 would inflate it the other
    way.
    """
    mask = labels != IGNORE_INDEX
    p = preds[mask]
    y = labels[mask]
    tp = torch.zeros(num_labels, device=p.device)
    fp = torch.zeros(num_labels, device=p.device)
    fn = torch.zeros(num_labels, device=p.device)
    for c in range(num_labels):
        pred_c = p == c
        true_c = y == c
        tp[c] = (pred_c & true_c).sum().float()
        fp[c] = (pred_c & ~true_c).sum().float()
        fn[c] = (~pred_c & true_c).sum().float()
    support = tp + fn  # number of true instances of each label in the val set
    precision = tp / (tp + fp + 1e-9)
    recall = tp / (tp + fn + 1e-9)
    f1 = 2 * precision * recall / (precision + recall + 1e-9)
    per_label = {bio_labels[c]: float(f1[c]) for c in range(num_labels)}
    per_label_support = {bio_labels[c]: int(support[c]) for c in range(num_labels)}

    supported = [c for c in range(num_labels) if bio_labels[c] != "O" and support[c] > 0]
    macro = sum(float(f1[c]) for c in supported) / len(supported) if supported else 0.0

    result = {"macro_f1": macro, **{f"f1.{k}": v for k, v in per_label.items()}}
    tags = tuple(dict.fromkeys(label.split("-", 1)[1] for label in bio_labels if "-" in label))
    for tag in tags:
        b_f1 = per_label.get(f"B-{tag}", 0.0)
        i_f1 = per_label.get(f"I-{tag}", 0.0)
        result[f"f1_tag.{tag}"] = (b_f1 + i_f1) / 2.0
        result[f"support_tag.{tag}"] = per_label_support.get(f"B-{tag}", 0) + per_label_support.get(f"I-{tag}", 0)
    return result


def cross_pollution(
    preds: torch.Tensor,
    labels: torch.Tensor,
    row_locale_ids: torch.Tensor | None,
) -> dict[str, float]:
    """How often a gold city or region START token is predicted as part of a postcode.

    The direct readout of the failure self-conditioning exists to stop: a city's lead token bleeding
    into the postcode span. Overall, plus per-locale when ``row_locale_ids`` is supplied. The
    pre-registered PR3 bar is under 1% per locale by 20k steps.

    Answers an empty dict when the validation sample contains no city or region start tokens at all
    — no rate is defined over an empty denominator, and 0.0 would read as a clean result.
    """
    start = torch.zeros_like(labels, dtype=torch.bool)
    for name in ("B-locality", "B-region"):
        start |= labels == LABEL_TO_ID[name]
    pc = torch.zeros_like(preds, dtype=torch.bool)
    for name in ("B-postcode", "I-postcode"):
        pc |= preds == LABEL_TO_ID[name]
    polluted = start & pc

    def _rate(mask_start: torch.Tensor, mask_poll: torch.Tensor) -> float:
        denom = int(mask_start.sum())
        return float(int(mask_poll.sum()) / denom) if denom > 0 else 0.0

    if int(start.sum()) == 0:
        return {}
    out: dict[str, float] = {"cross_pollution": _rate(start, polluted)}
    if row_locale_ids is not None:
        tok_locale = row_locale_ids.unsqueeze(1).expand_as(labels)
        for lid in torch.unique(row_locale_ids).tolist():
            if lid not in ID_TO_LOCALE:  # IGNORE_INDEX / unmapped country
                continue
            sel = tok_locale == lid
            if int((start & sel).sum()) > 0:
                out[f"cross_pollution.{ID_TO_LOCALE[lid]}"] = _rate(start & sel, polluted & sel)
    return out


def eval_csv_row(step: int, elapsed: float, val: Mapping[str, float], tags: Sequence[str]) -> list[str | int]:
    """The train_log.csv eval row, one `f1.<tag>` cell per tag of the run's label set.

    The header is written from the run's label set, so the row must be too. A row built from the
    default 16-tag list against a 35-tag ``stage3-cjk`` header left every JP fine tag and
    ``locality_unit`` unreadable, and shifted the cells that were present under the wrong names.
    """
    cells: list[str | int] = [
        step,
        f"{elapsed:.1f}",
        "",
        "",
        f"{val.get('val_loss', float('nan')):.6f}",
        f"{val.get('macro_f1', 0.0):.6f}",
    ]
    for tag in tags:
        supported = int(val.get(f"support_tag.{tag}", 0)) > 0
        cells.append(f"{val.get(f'f1_tag.{tag}', 0.0):.6f}" if supported else "")
    return cells
