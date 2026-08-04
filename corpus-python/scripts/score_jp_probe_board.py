"""Score a v8 JP char model on the municipality-held-out board (the pre-registered gate read).

PRE-REGISTERED DEFINITION — written before any board inference was run (the bars-are-bars rule):

- Inference: the trained char-mode checkpoint argmax-decodes per-char BIO over each board row's
  ``raw`` (same encode path as training: ``encode_row_units``, one unit per char, ctx 3 / W 7 /
  S 96, the sealed train-split char vocab). No CRF, no channels, no heals.
- Span reconstruction: contiguous ``B-``/``I-`` runs of the same tag over the char sequence; a
  row's predicted REGION and LOCALITY are the concatenated chars of the first such span per tag.
- Resolve: predicted (region, locality) → the (pref|muni) centroid table built from the FULL
  Overture-JP parquet (mean point per municipality, 1,530 entries) via exact NFC/space-stripped
  kanji match. No fuzzy matching — a hallucinated or truncated name misses, and that is the point.
- **Coordinate-acceptability: haversine(resolved centroid, the row's gold point) <= 15 km.**
  A row whose predicted pair is absent from the table is UNACCEPTABLE. 15 km covers the areal
  spread of large municipalities around their own centroid (the WOF-JP point-geometry situation:
  municipality centroids suffice — the architecture plan's stated resolution).
- **GATE (Leg 1, pre-registered 2026-07-18): acceptable fraction >= 0.70.**
- Secondary diagnostics reported alongside (the FAIL ladder's first rung, computed either way):
  per-tag span exact-match rates (region/locality/street/house_number/postcode vs the board's
  gold spans) and the unresolved-pair count.

--- Phase-3 additions (2026-08-05). The gate above is UNCHANGED; both additions are diagnostic. ---

**Per-register acceptability.** The full JP shard (#1458) writes a ``register`` column on every
board row — which of the four surfaces ``build_jp_shard`` rendered it in (``native`` /
``arabic_chome`` / ``compact_folded`` / ``designator``). One blended number cannot tell "the model
reads Japanese" from "the model reads the 68% of the board that is the source's own surface", and
the two synthesized registers are exactly the ones the source never contains — so they are the ones
a blended average hides. This script now splits the SAME per-row outcomes by that column and prints
the breakdown under the blended number. **The gate is still the blended fraction >= 0.70**; a
per-register number has no bar attached to it and cannot pass or fail anything. Boards with no
``register`` column (the Leg-1 probe board) simply get no breakdown — the blended read is identical.

**Label-set / resolve-tag parameterization.** The Leg-1 board was STAGE3, where the JP admin ladder
was mapped prefecture → ``region`` and municipality → ``locality``. The Phase-3 board is
``stage3-jp``, where those are their own tags (``prefecture`` / ``municipality``) in a 47-label
head. Reading the module-global 33-label ``ID_TO_LABEL`` against a 47-label checkpoint would
mislabel silently (the #1349 lesson), so ``--label-set`` selects the vocabulary and the resolve tags
default from it. ``--label-set stage3`` reproduces the Leg-1 read exactly.

Usage:
  # Leg-1 probe board (unchanged behavior)
  uv run python scripts/score_jp_probe_board.py --checkpoint <dir-with-pytorch_model.bin>

  # Phase-3 full-shard board
  uv run python scripts/score_jp_probe_board.py --checkpoint <dir> --label-set stage3-jp \
      --board $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-full-2026-08-04/jp-board.jsonl \
      --vocab $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-full-2026-08-04/char-vocab-jp-full.json \
      --centroids $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-probe/jp-muni-centroids.json

  (The centroid table is keyed on raw kanji ``pref|muni`` and was built from the FULL Overture-JP
  parquet, so it is label-set independent and the probe-dir copy is the right one to reuse.)
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from mailwoman_train.labels import resolve_label_set  # noqa: E402

DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data")
PROBE_DIR = Path(DATA_ROOT) / "corpus" / "versioned" / "v8-jp-probe"

CTX = 3
WIDTH = 7
MAX_UNITS = 96
ACCEPT_KM = 15.0
GATE = 0.70

# Which two predicted spans get concatenated into the centroid-table key, per label set. STAGE3 is
# the Leg-1 mapping (prefecture → region, municipality → locality); stage3-jp gives them own tags.
RESOLVE_TAGS: dict[str, tuple[str, str]] = {
    "stage3": ("region", "locality"),
    "stage3-jp": ("prefecture", "municipality"),
}


def norm_key(s: str) -> str:
    return "".join(unicodedata.normalize("NFC", s).split()).replace("　", "")


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def decode_spans(raw: str, label_ids: Sequence[int], id_to_label: Mapping[int, str]) -> dict[str, str]:
    """First contiguous B/I run per tag over the char sequence -> concatenated surface."""
    spans: dict[str, str] = {}
    cur_tag: str | None = None
    cur_chars: list[str] = []
    for i, ch in enumerate(raw[: len(label_ids)]):
        label = id_to_label[label_ids[i]] if label_ids[i] >= 0 else "O"
        if label == "O":
            tag = None
        else:
            prefix, tag = label.split("-", 1)
            if prefix == "B" or tag != cur_tag:
                if cur_tag is not None and cur_tag not in spans:
                    spans[cur_tag] = "".join(cur_chars)
                cur_tag, cur_chars = tag, []
        if tag is None:
            if cur_tag is not None and cur_tag not in spans:
                spans[cur_tag] = "".join(cur_chars)
            cur_tag, cur_chars = None, []
        else:
            cur_chars.append(ch)
    if cur_tag is not None and cur_tag not in spans:
        spans[cur_tag] = "".join(cur_chars)
    return spans


def score_board(
    rows: Iterable[Mapping],
    predict: Callable[[str], Sequence[int]],
    centroids: Mapping[str, Sequence[float]],
    *,
    id_to_label: Mapping[int, str],
    resolve_tags: tuple[str, str],
    accept_km: float = ACCEPT_KM,
) -> dict:
    """Run the pre-registered read over ``rows``, plus the per-register split of the same outcomes.

    ``predict(raw) -> per-character label ids`` is injected so the arithmetic is testable without a
    checkpoint (and without importing torch). ``main`` supplies the real argmax decoder.

    The blended ``fraction`` is computed exactly as the pre-registered definition states —
    ``acceptable / len(rows)``, an unresolved pair counting as unacceptable. ``per_register`` is the
    same per-row outcomes bucketed by the board's ``register`` column and carries no bar.
    """
    region_tag, locality_tag = resolve_tags
    n = 0
    acceptable = 0
    unresolved = 0
    tag_hit: Counter[str] = Counter()
    tag_total: Counter[str] = Counter()
    reg_rows: Counter[str] = Counter()
    reg_acceptable: Counter[str] = Counter()
    reg_unresolved: Counter[str] = Counter()

    for r in rows:
        n += 1
        raw = r["raw"]
        ids = list(predict(raw))[: len(raw)]
        pred = decode_spans(raw, ids, id_to_label)

        # Per-tag exact-match diagnostics vs the board's gold spans.
        gold = {t: raw[s:e] for s, e, t in zip(r["span_starts"], r["span_ends"], r["span_tags"], strict=True)}
        for t, g in gold.items():
            tag_total[t] += 1
            if pred.get(t) == g:
                tag_hit[t] += 1

        register = r.get("register")
        if register is not None:
            reg_rows[register] += 1

        key = norm_key(pred.get(region_tag, "") + "|" + pred.get(locality_tag, ""))
        hit = centroids.get(key)
        if hit is None:
            unresolved += 1
            if register is not None:
                reg_unresolved[register] += 1
            continue
        if haversine_km(hit[0], hit[1], r["lon"], r["lat"]) <= accept_km:
            acceptable += 1
            if register is not None:
                reg_acceptable[register] += 1

    per_register = {
        name: {
            "rows": count,
            "acceptable": reg_acceptable[name],
            "unresolved": reg_unresolved[name],
            "fraction": reg_acceptable[name] / count,
        }
        for name, count in reg_rows.items()
    }
    return {
        "rows": n,
        "acceptable": acceptable,
        "unresolved": unresolved,
        "fraction": acceptable / n if n else 0.0,
        "tag_hit": tag_hit,
        "tag_total": tag_total,
        "per_register": per_register,
    }


def format_report(result: Mapping, *, accept_km: float = ACCEPT_KM, gate: float = GATE) -> str:
    """The printed read. The gate line is the blended fraction and nothing else."""
    lines = [f"board rows: {result['rows']}; unresolved (pred pair not in table): {result['unresolved']}"]
    tag_total, tag_hit = result["tag_total"], result["tag_hit"]
    lines.append("per-tag span exact-match:")
    for t in sorted(tag_total):
        lines.append(f"  {t:<16} {tag_hit[t] / tag_total[t]:.4f}  ({tag_hit[t]}/{tag_total[t]})")

    per_register = result["per_register"]
    if per_register:
        lines.append("")
        lines.append(f"per-register acceptability (<= {accept_km:g} km) — DIAGNOSTIC, not the gate:")
        for name, stats in sorted(per_register.items(), key=lambda kv: -kv[1]["rows"]):
            lines.append(
                f"  {name:<16} {stats['fraction']:.4f}  "
                f"({stats['acceptable']}/{stats['rows']})  unresolved {stats['unresolved']}"
            )
    else:
        lines.append("")
        lines.append("per-register acceptability: board carries no `register` column — no breakdown.")

    lines.append("")
    lines.append(
        f"COORD-ACCEPTABILITY (<= {accept_km:g} km): {result['fraction']:.4f}  "
        f"({result['acceptable']}/{result['rows']})"
    )
    lines.append(f"GATE >= {gate:.2f}: {'PASS' if result['fraction'] >= gate else 'FAIL'}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--board", default=str(PROBE_DIR / "jp-probe-board.jsonl"))
    ap.add_argument("--vocab", default=str(PROBE_DIR / "char-vocab-jp-v1.json"))
    ap.add_argument("--centroids", default=str(PROBE_DIR / "jp-muni-centroids.json"))
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
    args = ap.parse_args()

    # Imported here, not at module scope, so the pure scoring arithmetic above stays importable
    # (and testable) without the torch install.
    import torch

    from mailwoman_train.char_tokenizer import encode_row_units, load_char_vocab
    from mailwoman_train.model import MailwomanCoarseEncoder

    label_set = resolve_label_set(args.label_set)
    resolve_tags = RESOLVE_TAGS[args.label_set]
    if args.resolve_tags:
        first, _, second = args.resolve_tags.partition(",")
        resolve_tags = (first.strip(), second.strip())
    for tag in resolve_tags:
        if tag not in label_set.tags:
            raise SystemExit(f"resolve tag {tag!r} is not in label set {args.label_set!r}")

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
        return out.logits[0].argmax(-1).tolist()

    rows = [json.loads(ln) for ln in Path(args.board).read_text().splitlines() if ln.strip()]
    with torch.no_grad():
        result = score_board(
            rows,
            predict,
            centroids,
            id_to_label=label_set.id_to_label,
            resolve_tags=resolve_tags,
        )
    print(format_report(result))


if __name__ == "__main__":
    main()
