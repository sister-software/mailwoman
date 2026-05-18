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
) -> dict:
    """Construct the ModelCard payload. Fields per Phase 2 §10."""
    return {
        "name": f"neural-weights-{locale}",
        "version": "0.1.0",
        "phase": "Stage 1 (coarse)",
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
        "components_supported": [
            "country",
            "region",
            "locality",
            "dependent_locality",
            "postcode",
            "subregion",
            "cedex",
        ],
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
        },
        "base_relpath": str(base_path) if base_path else "",
    }


def write_package(
    package_dir: Path,
    *,
    int8_model_path: Path,
    tokenizer_model_path: Path,
    model_card: dict,
    package_json: dict,
    readme_md: str,
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
    return package_dir


def render_package_json(locale: str) -> dict:
    return {
        "name": f"@mailwoman/neural-weights-{locale}",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "description": (
            f"Mailwoman neural-classifier weights for locale '{locale}'. "
            "Data-only package — loaded by @mailwoman/neural at runtime."
        ),
        "files": ["model.onnx", "tokenizer.model", "model-card.json", "README.md"],
        "publishConfig": {"access": "public"},
        "repository": {"type": "git", "url": "https://github.com/sister-software/mailwoman"},
        "private": False,
    }


_PHASE2_TARGETS = {
    "country": 0.95,
    "region": 0.95,
    "locality": 0.95,
    "postcode": 0.95,
}


def _phase2_status_line(eval_report: dict) -> str:
    """Honest one-liner about how this build measures up to the Phase 2 §6 95% F1 target."""
    per = eval_report.get("per_component", {}) or {}
    components_at_target: list[str] = []
    components_below: list[tuple[str, float]] = []
    for tag, target in _PHASE2_TARGETS.items():
        if tag not in per:
            continue
        f1 = float(per[tag].get("f1", 0.0))
        if f1 >= target:
            components_at_target.append(tag)
        else:
            components_below.append((tag, f1))
    if not components_below:
        return "**✓ Meets Phase 2 §6 targets (≥95% F1) on every coarse component.**"
    lines = [
        "**⚠ Below Phase 2 §6 targets (≥95% F1):**",
        "",
    ]
    for tag, f1 in components_below:
        lines.append(f"- `{tag}` F1 = **{f1:.4f}** (target ≥0.95)")
    if components_at_target:
        lines.append("")
        lines.append("At target: " + ", ".join(f"`{t}`" for t in components_at_target))
    return "\n".join(lines)


def render_readme(
    *,
    locale: str,
    corpus_version: str,
    eval_report: dict,
    training_steps: int,
    training_hardware: str,
    smoke: bool,
) -> str:
    head = f"# @mailwoman/neural-weights-{locale}"
    if smoke:
        head += "\n\n> **⚠ SMOKE BUILD — NOT PRODUCTION WEIGHTS.** "
        head += "This package was assembled from a Phase 2 smoke training run to validate the "
        head += "pipeline end-to-end. The model is undertrained and does not meet the §6 success "
        head += "criteria. Replace with weights from a full GPU-host training run before publishing."
    lines = [
        head,
        "",
        "Phase 2 / Stage 1 (coarse) Mailwoman neural-classifier weights.",
        "",
        f"- locale: **{locale}**",
        f"- corpus: **{corpus_version}**",
        f"- training steps: **{training_steps}**",
        f"- hardware: **{training_hardware}**",
        "",
        "## Phase 2 §6 status",
        "",
        _phase2_status_line(eval_report),
        "",
        "## Eval (golden set)",
        "",
        f"- entries: **{eval_report.get('n_entries', 0)}**",
        f"- full-parse exact match: **{eval_report.get('full_parse_exact_match', 0.0):.4f}**",
        f"- mean token confidence: **{eval_report.get('mean_token_confidence', 0.0):.4f}**",
        "",
        "## Components supported",
        "",
        "Stage 1 ships coarse-only: country / region / locality / dependent_locality / postcode "
        "/ subregion / cedex. Street- and venue-level components are explicit future phases.",
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
