"""Build the ``packages/neural-weights-{en-us,fr-fr}/`` data-only directories.

Per Phase 2 §9:

- Each weights package contains:
  - ``model.onnx`` (int8 quantized)
  - ``tokenizer.model`` (SentencePiece)
  - ``model-card.json`` (ModelCard per #6)
  - ``package.json`` (name, version, license)
  - README.md describing model + corpus + eval

- These are data-only. No JS code. Loaded by ``@mailwoman/neural`` at runtime (Phase 3).

Stage 1 multilingual ⚠: a single multilingual coarse model is exported per-locale with the
same weights. The locale split is a Phase 3 decision (per the Phase 2 §7 plan). Until then,
both packages ship byte-identical model.onnx + tokenizer.model.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

import torch

from .labels import ACTIVE_BIO_LABELS, ACTIVE_TAGS, STAGE1_COARSE_TAGS, STAGE2_FINE_TAGS, STAGE2_TAGS


def _phase_label() -> str:
    """Derive the ModelCard ``phase`` string from the active label set.

    Single source of truth: ``labels.ACTIVE_TAGS``. When the ship-line moves
    (e.g. ACTIVE bumps to a hypothetical STAGE3), this is the only place that
    needs to learn the new name.
    """
    if ACTIVE_TAGS == STAGE2_TAGS:
        return "Stage 2 (coarse + venue/street/house_number)"
    if ACTIVE_TAGS == STAGE1_COARSE_TAGS:
        return "Stage 1 (coarse)"
    return f"Custom ({len(ACTIVE_TAGS)} tags)"


def build_model_card(
    *,
    locale: str,
    corpus_version: str,
    tokenizer_version: str,
    training_steps: int,
    eval_report: dict,
    notes: str,
    training_hardware: str,
    training_duration_seconds: float,
    base_path: Path,
    package_version: str = "0.1.0",
) -> dict:
    """Construct the ModelCard payload. Fields per Phase 2 §10."""
    return {
        "name": f"neural-weights-{locale}",
        "version": package_version,
        "phase": _phase_label(),
        "license": "AGPL-3.0-only",
        "locale": locale,
        "training": {
            "corpus_version": corpus_version,
            "tokenizer_version": tokenizer_version,
            "steps": training_steps,
            "hardware": training_hardware,
            "duration_seconds": training_duration_seconds,
            "started_at": None,
            "completed_at": datetime.utcnow().isoformat() + "Z",
        },
        "components_supported": list(ACTIVE_TAGS),
        # BIO label vocabulary in the exact order the model emits logits. The JS-side
        # `@mailwoman/neural` loader reads this at runtime so it never has to guess
        # the active stage's label space; missing field => loader falls back to its
        # compile-time default (STAGE2_BIO_LABELS), preserving back-compat with the
        # v3.0.0 published card which predates this field.
        "labels": list(ACTIVE_BIO_LABELS),
        "eval": eval_report,
        "known_failure_modes": [
            "underperforms on Hawaiian addresses (sparse in training corpus)",
            "particle-honorific kryptonite (e.g. FR 'Saint-Just-Saint-Rambert') if not in synth set",
            "non-Latin scripts (CJK, Cyrillic) fall through to byte-fallback tokens; F1 unknown",
        ],
        "notes": notes,
        "format": {
            "model": "ONNX int8 dynamic",
            "tokenizer": "SentencePiece unigram, byte_fallback=true, vocab_size=16000",
            "max_sequence_length": 128,
            "opset": 17,
        },
        "files": {
            "model": "model.onnx",
            "tokenizer": "tokenizer.model",
            "model_card": "model-card.json",
            "crf_transitions": "crf-transitions.json",
        },
        "base_relpath": str(base_path) if base_path else "",
    }


def export_crf_transitions(model: "torch.nn.Module") -> dict | None:
    """Extract learned CRF transition parameters from a trained model.

    Returns None if the model has no CRF module (CE-only training) or if
    crf_loss_weight was 0.0 (CRF present but untrained — parameters are noise).
    """
    crf = getattr(model, "crf", None)
    if crf is None:
        return None
    transitions = crf.transitions.detach().cpu().float().numpy().tolist()
    start = crf.start_transitions.detach().cpu().float().numpy().tolist()
    end = crf.end_transitions.detach().cpu().float().numpy().tolist()
    return {
        "labels": list(ACTIVE_BIO_LABELS),
        "transitions": transitions,
        "start_transitions": start,
        "end_transitions": end,
    }


def write_package(
    package_dir: Path,
    *,
    int8_model_path: Path,
    tokenizer_model_path: Path,
    model_card: dict,
    package_json: dict,
    readme_md: str,
    crf_transitions: dict | None = None,
) -> Path:
    """Write a single weights package directory. Idempotent: overwrites contents."""
    package_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(int8_model_path, package_dir / "model.onnx")
    shutil.copyfile(tokenizer_model_path, package_dir / "tokenizer.model")
    (package_dir / "model-card.json").write_text(
        json.dumps(model_card, indent=2) + "\n", encoding="utf-8"
    )
    (package_dir / "package.json").write_text(
        json.dumps(package_json, indent=2) + "\n", encoding="utf-8"
    )
    (package_dir / "README.md").write_text(readme_md, encoding="utf-8")
    if crf_transitions is not None:
        (package_dir / "crf-transitions.json").write_text(
            json.dumps(crf_transitions, indent=2) + "\n", encoding="utf-8"
        )
    return package_dir


def render_package_json(locale: str, *, package_version: str = "0.1.0") -> dict:
    return {
        "name": f"@mailwoman/neural-weights-{locale}",
        "version": package_version,
        "license": "AGPL-3.0-only",
        "description": (
            f"Mailwoman neural-classifier weights for locale '{locale}'. "
            "Data-only package — loaded by @mailwoman/neural at runtime."
        ),
        "files": ["model.onnx", "tokenizer.model", "model-card.json", "crf-transitions.json", "README.md"],
        "publishConfig": {"access": "public"},
        "repository": {"type": "git", "url": "https://github.com/sister-software/mailwoman"},
        "private": False,
    }


# Per-component F1 floors. Coarse targets are the original Phase 2 §6 0.95 contract.
# Stage 2 fine labels carry the v0.3.0 issue-spec floors: 0.6 venue, 0.7 street,
# 0.8 house_number (issue #57 "per-iteration success metric"). Tags absent from
# ACTIVE_TAGS are silently skipped at status-line time.
_F1_TARGETS: dict[str, float] = {
    "country": 0.95,
    "region": 0.95,
    "locality": 0.95,
    "postcode": 0.95,
    "venue": 0.60,
    "street": 0.70,
    "house_number": 0.80,
}


def _target_status_line(eval_report: dict) -> str:
    """Honest one-liner about how this build measures up to the per-tag F1 floors."""
    per = eval_report.get("per_component", {}) or {}
    active_tags = set(ACTIVE_TAGS)
    components_at_target: list[str] = []
    components_below: list[tuple[str, float, float]] = []
    for tag, target in _F1_TARGETS.items():
        if tag not in active_tags or tag not in per:
            continue
        f1 = float(per[tag].get("f1", 0.0))
        if f1 >= target:
            components_at_target.append(tag)
        else:
            components_below.append((tag, f1, target))
    if not components_below:
        return "**✓ Meets per-component F1 targets on every active component.**"
    lines = [
        "**⚠ Below per-component F1 targets:**",
        "",
    ]
    for tag, f1, target in components_below:
        lines.append(f"- `{tag}` F1 = **{f1:.4f}** (target ≥{target:.2f})")
    if components_at_target:
        lines.append("")
        lines.append("At target: " + ", ".join(f"`{t}`" for t in components_at_target))
    return "\n".join(lines)


# Back-compat alias — older callers may still import the old name.
_phase2_status_line = _target_status_line


def _components_supported_blurb() -> str:
    """One-line description of the active component set, derived from labels.ACTIVE_TAGS."""
    if ACTIVE_TAGS == STAGE2_TAGS:
        coarse = " / ".join(STAGE1_COARSE_TAGS)
        fine = " / ".join(STAGE2_FINE_TAGS)
        return (
            f"Stage 2 ships coarse ({coarse}) plus fine-grained {fine}. "
            "Token classifier emits 21 BIO labels."
        )
    if ACTIVE_TAGS == STAGE1_COARSE_TAGS:
        return (
            "Stage 1 ships coarse-only: " + " / ".join(STAGE1_COARSE_TAGS) + ". "
            "Street- and venue-level components are explicit future phases."
        )
    tags = " / ".join(ACTIVE_TAGS)
    return f"Components: {tags}."


def render_readme(
    *,
    locale: str,
    corpus_version: str,
    eval_report: dict,
    training_steps: int,
    training_hardware: str,
    smoke: bool,
) -> str:
    phase = _phase_label()
    head = f"# @mailwoman/neural-weights-{locale}"
    if smoke:
        head += "\n\n> **⚠ SMOKE BUILD — NOT PRODUCTION WEIGHTS.** "
        head += "This package was assembled from a Phase 2 smoke training run to validate the "
        head += "pipeline end-to-end. The model is undertrained and does not meet the §6 success "
        head += "criteria. Replace with weights from a full GPU-host training run before publishing."
    lines = [
        head,
        "",
        f"{phase} Mailwoman neural-classifier weights.",
        "",
        f"- locale: **{locale}**",
        f"- corpus: **{corpus_version}**",
        f"- training steps: **{training_steps}**",
        f"- hardware: **{training_hardware}**",
        "",
        "## Per-component F1 targets",
        "",
        _target_status_line(eval_report),
        "",
        "## Eval (golden set)",
        "",
        f"- entries: **{eval_report.get('n_entries', 0)}**",
        f"- full-parse exact match: **{eval_report.get('full_parse_exact_match', 0.0):.4f}**",
        f"- mean token confidence: **{eval_report.get('mean_token_confidence', 0.0):.4f}**",
        "",
        "## Components supported",
        "",
        _components_supported_blurb(),
        "",
        "## Files",
        "",
        "- `model.onnx` — int8-quantized ONNX model.",
        "- `tokenizer.model` — SentencePiece unigram tokenizer (matches the corpus version).",
        "- `model-card.json` — ModelCard with training + eval metadata.",
        "",
        "## Loader",
        "",
        "Loaded at runtime by `@mailwoman/neural`. This package contains no JS code.",
        "",
    ]
    return "\n".join(lines) + "\n"
