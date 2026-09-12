"""Printing the read, and running it against a checkpoint.

torch and the encoder are imported inside `main`, not at module scope, so `score` and `decode` stay
importable — and testable — without the torch install.
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ...labels import resolve_label_set
from ...paths import data_root_path
from .score import ACCEPT_KM, CHECK, RESOLVE_TAGS, score_board

#: Resolved when a default is needed, not at import: this module is loaded by path in
#: `test_jp_board_registers`, where no data root is configured and none is required.
PROBE_DIR_PARTS = ("corpus", "versioned", "v8-jp-probe")

CTX = 3
WIDTH = 7
MAX_UNITS = 96


def probe_dir(*parts: str) -> Path:
    """The probe corpus directory under `$MAILWOMAN_DATA_ROOT`."""
    return data_root_path(*PROBE_DIR_PARTS, *parts)


def format_report(
    result: Mapping[str, Any],
    *,
    accept_km: float = ACCEPT_KM,
    check: float = CHECK,
    all_municipalities: bool = False,
) -> str:
    """The printed read. The check line is the blended fraction and nothing else."""
    lines = [
        f"board rows: {result['rows']}; unresolved (pred pair not in table): {result['unresolved']}"
        f" (of which gold-exact, centroid within {accept_km:g} km by the row's own kanji: {result.get('gold_exact_unresolved', 0)})"
    ]
    tag_total, tag_hit = result["tag_total"], result["tag_hit"]
    lines.append("per-tag span exact-match:")
    for t in sorted(tag_total):
        lines.append(f"  {t:<16} {tag_hit[t] / tag_total[t]:.4f}  ({tag_hit[t]}/{tag_total[t]})")

    per_register = result["per_register"]
    if per_register:
        lines.append("")
        lines.append(f"per-register acceptability (<= {accept_km:g} km) — DIAGNOSTIC, not the check:")
        for name, stats in sorted(per_register.items(), key=lambda kv: -kv[1]["rows"]):
            lines.append(
                f"  {name:<16} {stats['fraction']:.4f}  "
                f"({stats['acceptable']}/{stats['rows']})  unresolved {stats['unresolved']}"
                f" (gold-exact {stats.get('gold_exact', 0)})"
            )
    else:
        lines.append("")
        lines.append("per-register acceptability: board carries no `register` column — no breakdown.")

    per_municipality = result.get("per_municipality") or {}
    if per_municipality:
        lines.append("")
        lines.append(
            f"municipality macro (mean of per-municipality acceptability over {len(per_municipality)} held-out "
            f"municipalities) — a READING beside the blended check: {result['municipality_macro']:.4f}"
        )
        worst = sorted(per_municipality.items(), key=lambda kv: (kv[1]["fraction"], -kv[1]["rows"]))[:5]
        lines.append("  lowest five (name, acceptable/rows):")
        for name, stats in worst:
            lines.append(f"    {name:<12} {stats['fraction']:.4f}  ({stats['acceptable']}/{stats['rows']})")
        if all_municipalities:
            lines.append("  every held-out municipality (name, acceptable/rows, gold-exact among unresolved):")
            for name, stats in sorted(per_municipality.items(), key=lambda kv: (kv[1]["fraction"], -kv[1]["rows"])):
                lines.append(
                    f"    {name:<12} {stats['fraction']:.4f}  ({stats['acceptable']}/{stats['rows']})"
                    f"  gold-exact {stats.get('gold_exact', 0)}"
                )

    lines.append("")
    lines.append(
        f"COORD-ACCEPTABILITY (<= {accept_km:g} km): {result['fraction']:.4f}  "
        f"({result['acceptable']}/{result['rows']})"
    )
    lines.append(f"CHECK >= {check:.2f}: {'PASS' if result['fraction'] >= check else 'FAIL'}")
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument(
        "--all-municipalities", action="store_true", help="print every held-out municipality, not the lowest five"
    )
    probe = "$MAILWOMAN_DATA_ROOT/" + "/".join(PROBE_DIR_PARTS)
    ap.add_argument("--board", default=None, help=f"defaults to {probe}/jp-probe-board.jsonl")
    ap.add_argument("--vocab", default=None, help=f"defaults to {probe}/char-vocab-jp-v1.json")
    ap.add_argument("--centroids", default=None, help=f"defaults to {probe}/jp-muni-centroids.json")
    ap.add_argument(
        "--label-set",
        default="stage3",
        choices=sorted(RESOLVE_TAGS),
        help="the checkpoint's label vocabulary; also picks the default resolve tags",
    )
    ap.add_argument(
        "--resolve-tags",
        default=None,
        help="override the two tags concatenated into the centroid key, as 'region,locality'",
    )
    args = ap.parse_args(argv)
    args.board = args.board or str(probe_dir("jp-probe-board.jsonl"))
    args.vocab = args.vocab or str(probe_dir("char-vocab-jp-v1.json"))
    args.centroids = args.centroids or str(probe_dir("jp-muni-centroids.json"))
    return args


def resolve_tags_for(args: argparse.Namespace, label_set: Any) -> tuple[str, str]:
    """The two tags the centroid key is built from, defaulted by label set and overridable."""
    resolve_tags = RESOLVE_TAGS[args.label_set]
    if args.resolve_tags:
        first, _, second = args.resolve_tags.partition(",")
        resolve_tags = (first.strip(), second.strip())
    for tag in resolve_tags:
        if tag not in label_set.tags:
            raise SystemExit(f"resolve tag {tag!r} is not in label set {args.label_set!r}")
    return resolve_tags


def main() -> None:
    args = parse_args()

    # Imported here, not at module scope, so the pure scoring arithmetic stays importable
    # (and testable) without the torch install.
    import torch

    from ...nn.encoder import MailwomanCoarseEncoder
    from ...tokenizer.char import encode_row_units, load_char_vocab

    label_set = resolve_label_set(args.label_set)
    resolve_tags = resolve_tags_for(args, label_set)

    vocab = load_char_vocab(args.vocab)
    centroids = json.loads(Path(args.centroids).read_text())
    model = MailwomanCoarseEncoder.from_pretrained(args.checkpoint).eval()
    if model.num_labels != len(label_set.bio_labels):
        raise SystemExit(
            f"checkpoint has {model.num_labels} labels but --label-set {args.label_set!r} has "
            f"{len(label_set.bio_labels)} — a silent mismatch would mislabel every span (#1349)"
        )

    def predict(raw: str) -> list[int]:
        enc = encode_row_units(
            raw,
            [(i, i + 1) for i in range(len(raw))],
            ["O"] * len(raw),
            vocab,
            max_units=MAX_UNITS,
            max_unit_width=WIDTH,
            ctx_chars=CTX,
        )
        out = model(
            input_ids=torch.zeros(1, MAX_UNITS, dtype=torch.long),
            attention_mask=torch.tensor([enc["attention_mask"]], dtype=torch.long),
            char_ids=torch.tensor([enc["char_ids"]], dtype=torch.long),
        )
        ids: list[int] = out.logits[0].argmax(-1).tolist()
        return ids

    rows = [json.loads(ln) for ln in Path(args.board).read_text().splitlines() if ln.strip()]
    with torch.no_grad():
        result = score_board(
            rows,
            predict,
            centroids,
            id_to_label=label_set.id_to_label,
            resolve_tags=resolve_tags,
        )
    print(format_report(result, all_municipalities=args.all_municipalities))
