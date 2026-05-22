"""Eval against the golden set.

Per Phase 2 §6:

- Per-component F1 / precision / recall.
- Full-parse exact match (every component correct).
- Mean token confidence.
- Calibration: bucketed accuracy-per-confidence histogram.
- Writes a markdown report alongside the checkpoint.
- Compares against a rule-baseline cache (if provided).

The golden set lives at ``data/eval/golden/v0.1.0/`` (in-repo JSONL, schema:
``{raw, components, country, source, notes?}``). We translate ground-truth components to
char-level Stage 1 BIO labels via substring search in ``raw`` (the same invariant the
JS-side validator enforces), then compare to model predictions decoded back to component
strings.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import torch

from .config import Config
from .labels import ACTIVE_BIO_LABELS, ACTIVE_TAGS
from .tokenizer import Tokenizer


@dataclass
class GoldenEntry:
    raw: str
    components: dict[str, str]
    country: str
    notes: str = ""


def load_golden_dir(golden_dir: Path) -> list[GoldenEntry]:
    entries: list[GoldenEntry] = []
    for jsonl_path in sorted(golden_dir.glob("*.jsonl")):
        with jsonl_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                entries.append(
                    GoldenEntry(
                        raw=obj["raw"],
                        components={k: v for k, v in obj["components"].items()},
                        country=obj["country"],
                        notes=obj.get("notes", ""),
                    )
                )
    return entries


def golden_to_bio_labels(entry: GoldenEntry, max_length: int, tokenizer: Tokenizer) -> tuple[list[int], list[int], list[int]]:
    """Encode ``entry.raw`` and assign ACTIVE BIO labels via substring search.

    Components whose values can't be located in ``raw`` are silently skipped — they are golden
    set rot the JS-side validator should have caught. We could log them, but eval should be
    resilient to a few stray entries.

    Returns (input_ids, attention_mask, label_ids).
    """
    pieces = tokenizer.encode_with_spans(entry.raw)
    char_labels = ["O"] * len(entry.raw)
    for tag, value in entry.components.items():
        if tag not in ACTIVE_TAGS or not value:
            continue
        # Greedy first-occurrence substring search.
        idx = entry.raw.find(value)
        if idx < 0:
            continue
        end = idx + len(value)
        for i in range(idx, end):
            char_labels[i] = f"B-{tag}" if i == idx else f"I-{tag}"

    from .labels import LABEL_TO_ID

    label_ids: list[int] = []
    prev_tag: str | None = None
    for piece in pieces:
        first = "O"
        for i in range(piece.char_begin, piece.char_end):
            if i < len(char_labels) and not entry.raw[i].isspace():
                first = char_labels[i]
                break
        if first == "O" or "-" not in first:
            label_ids.append(LABEL_TO_ID["O"])
            prev_tag = None
        else:
            _, tag = first.split("-", 1)
            label_ids.append(LABEL_TO_ID[f"I-{tag}" if prev_tag == tag else f"B-{tag}"])
            prev_tag = tag

    input_ids = [p.piece_id for p in pieces][:max_length]
    attention = [1] * len(input_ids)
    label_ids = label_ids[:max_length]
    pad_needed = max_length - len(input_ids)
    if pad_needed > 0:
        input_ids.extend([tokenizer.pad_id] * pad_needed)
        attention.extend([0] * pad_needed)
        label_ids.extend([-100] * pad_needed)
    return input_ids, attention, label_ids


def decode_components(pieces, pred_label_ids: list[int], raw: str) -> dict[str, str]:
    """Convert a per-piece predicted label sequence into a {tag: surface_string} dict.

    For each contiguous run of ``B-TAG`` + ``I-TAG`` pieces, slice ``raw`` from the run's
    first char_begin to last char_end. Returns the first occurrence per tag (consistent with
    the golden set's single-value-per-tag schema).
    """
    out: dict[str, str] = {}
    current_tag: str | None = None
    current_begin: int = -1
    current_end: int = -1
    for i, (piece, lid) in enumerate(zip(pieces, pred_label_ids)):
        label = ACTIVE_BIO_LABELS[lid] if 0 <= lid < len(ACTIVE_BIO_LABELS) else "O"
        if label == "O":
            if current_tag is not None and current_tag not in out:
                out[current_tag] = raw[current_begin:current_end].strip()
            current_tag = None
            continue
        prefix, tag = label.split("-", 1)
        if prefix == "B" or current_tag != tag:
            if current_tag is not None and current_tag not in out:
                out[current_tag] = raw[current_begin:current_end].strip()
            current_tag = tag
            current_begin = piece.char_begin
            current_end = piece.char_end
        else:
            current_end = piece.char_end
    if current_tag is not None and current_tag not in out:
        out[current_tag] = raw[current_begin:current_end].strip()
    return out


@dataclass
class EvalReport:
    per_component: dict[str, dict[str, float]]
    full_parse_exact_match: float
    mean_token_confidence: float
    calibration: list[dict[str, float]]
    n_entries: int


def _f1(tp: int, fp: int, fn: int) -> dict[str, float]:
    p = tp / (tp + fp + 1e-9)
    r = tp / (tp + fn + 1e-9)
    return {"precision": p, "recall": r, "f1": 2 * p * r / (p + r + 1e-9), "support": tp + fn}


@torch.no_grad()
def run_eval(
    cfg: Config,
    model: torch.nn.Module,
    tokenizer: Tokenizer,
    golden_entries: Iterable[GoldenEntry],
    *,
    device: torch.device | None = None,
) -> EvalReport:
    device = device or next(model.parameters()).device
    model.eval()

    per_tag_counts = {tag: [0, 0, 0] for tag in ACTIVE_TAGS}
    full_match = 0
    confidences: list[float] = []
    confidence_correct: list[tuple[float, int]] = []
    n = 0

    entries = list(golden_entries)
    for entry in entries:
        n += 1
        pieces = tokenizer.encode_with_spans(entry.raw)
        ids, attn, _gold_ids = golden_to_bio_labels(entry, cfg.data.max_length, tokenizer)
        x = torch.tensor([ids], dtype=torch.long, device=device)
        m = torch.tensor([attn], dtype=torch.long, device=device)
        logits = model(input_ids=x, attention_mask=m).logits[0]
        probs = torch.softmax(logits, dim=-1)
        # Confidences come from emission softmax regardless of decoder. With CRF, the
        # decoded sequence may diverge from per-token argmax — confidence here reflects
        # the model's per-token belief, not the path's marginal likelihood. That's the
        # historical eval semantic; calibration plots stay comparable across v0.2.0 +
        # v0.3.0 with this read.
        pred_confs = probs.max(dim=-1).values.tolist()

        # Trim to non-padding length first so the decoder sees the same length the model
        # used. With CRF, predict() honors attention_mask + returns mask-trimmed lists.
        real_len = min(len(pieces), cfg.data.max_length)
        if hasattr(model, "predict") and getattr(model, "crf", None) is not None:
            decoded_batch = model.predict(input_ids=x, attention_mask=m)
            pred_ids = decoded_batch[0][:real_len] if decoded_batch else []
        else:
            pred_ids = probs.argmax(dim=-1).tolist()[:real_len]
        pred_confs = pred_confs[:real_len]
        pieces = pieces[:real_len]

        predicted = decode_components(pieces, pred_ids, entry.raw)
        gold = {k: v for k, v in entry.components.items() if k in ACTIVE_TAGS and v}

        all_correct = True
        seen_tags: set[str] = set()
        for tag in ACTIVE_TAGS:
            seen_tags.add(tag)
            g = gold.get(tag, "")
            p = predicted.get(tag, "")
            if g and p and p.strip() == g.strip():
                per_tag_counts[tag][0] += 1  # tp
            elif p and not g:
                per_tag_counts[tag][1] += 1  # fp
                all_correct = False
            elif g and not p:
                per_tag_counts[tag][2] += 1  # fn
                all_correct = False
            elif g and p and p.strip() != g.strip():
                per_tag_counts[tag][1] += 1  # fp
                per_tag_counts[tag][2] += 1  # fn
                all_correct = False
        if all_correct and gold:
            full_match += 1

        # Confidence/calibration: only over non-O predictions vs golden char labels.
        for i, (pid, conf) in enumerate(zip(pred_ids, pred_confs)):
            confidences.append(conf)
            correct = 1 if pid == _gold_ids[i] else 0
            confidence_correct.append((conf, correct))

    per_component = {
        tag: _f1(*counts) for tag, counts in per_tag_counts.items()
    }
    em = full_match / max(1, n)

    # Calibration buckets: 10 evenly spaced.
    buckets = [{"low": i / 10, "high": (i + 1) / 10, "n": 0, "acc": 0.0} for i in range(10)]
    for conf, correct in confidence_correct:
        b = min(9, int(conf * 10))
        buckets[b]["n"] += 1
        buckets[b]["acc"] += correct
    for b in buckets:
        if b["n"] > 0:
            b["acc"] = b["acc"] / b["n"]

    mean_conf = sum(confidences) / max(1, len(confidences))
    return EvalReport(
        per_component=per_component,
        full_parse_exact_match=em,
        mean_token_confidence=mean_conf,
        calibration=buckets,
        n_entries=n,
    )


def render_report_markdown(report: EvalReport, header: str = "") -> str:
    lines: list[str] = []
    if header:
        lines.append(f"# {header}")
        lines.append("")
    lines.append(f"- entries evaluated: **{report.n_entries}**")
    lines.append(f"- full-parse exact match: **{report.full_parse_exact_match:.4f}**")
    lines.append(f"- mean token confidence: **{report.mean_token_confidence:.4f}**")
    lines.append("")
    lines.append("## Per-component F1")
    lines.append("")
    lines.append("| tag | precision | recall | f1 | support |")
    lines.append("|---|---:|---:|---:|---:|")
    for tag in ACTIVE_TAGS:
        m = report.per_component[tag]
        lines.append(
            f"| {tag} | {m['precision']:.4f} | {m['recall']:.4f} | {m['f1']:.4f} | {int(m['support'])} |"
        )
    lines.append("")
    lines.append("## Calibration (confidence bucket → accuracy)")
    lines.append("")
    lines.append("| bucket | n | accuracy |")
    lines.append("|---|---:|---:|")
    for b in report.calibration:
        lines.append(f"| {b['low']:.1f}–{b['high']:.1f} | {b['n']} | {b['acc']:.4f} |")
    lines.append("")
    return "\n".join(lines)


def report_to_json(report: EvalReport) -> dict:
    return {
        "n_entries": report.n_entries,
        "full_parse_exact_match": report.full_parse_exact_match,
        "mean_token_confidence": report.mean_token_confidence,
        "per_component": report.per_component,
        "calibration": report.calibration,
    }
