"""Score the v8 JP Leg-1 probe on the municipality-held-out board (the pre-registered gate read).

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

Usage:
  uv run python scripts/score_jp_probe_board.py --checkpoint <dir-with-pytorch_model.bin> \
      [--board .../jp-probe-board.jsonl] [--vocab .../char-vocab-jp-v1.json] \
      [--centroids .../jp-muni-centroids.json]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import unicodedata
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import torch  # noqa: E402

from mailwoman_train.char_tokenizer import encode_row_units, load_char_vocab  # noqa: E402
from mailwoman_train.labels import ID_TO_LABEL  # noqa: E402
from mailwoman_train.model import MailwomanCoarseEncoder  # noqa: E402

DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data")
PROBE_DIR = Path(DATA_ROOT) / "corpus" / "versioned" / "v8-jp-probe"

CTX = 3
WIDTH = 7
MAX_UNITS = 96
ACCEPT_KM = 15.0


def norm_key(s: str) -> str:
    return "".join(unicodedata.normalize("NFC", s).split()).replace("　", "")


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def decode_spans(raw: str, label_ids: list[int]) -> dict[str, str]:
    """First contiguous B/I run per tag over the char sequence -> concatenated surface."""
    spans: dict[str, str] = {}
    cur_tag: str | None = None
    cur_chars: list[str] = []
    for i, ch in enumerate(raw[: len(label_ids)]):
        label = ID_TO_LABEL[label_ids[i]] if label_ids[i] >= 0 else "O"
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--board", default=str(PROBE_DIR / "jp-probe-board.jsonl"))
    ap.add_argument("--vocab", default=str(PROBE_DIR / "char-vocab-jp-v1.json"))
    ap.add_argument("--centroids", default=str(PROBE_DIR / "jp-muni-centroids.json"))
    args = ap.parse_args()

    vocab = load_char_vocab(args.vocab)
    centroids = json.loads(Path(args.centroids).read_text())
    model = MailwomanCoarseEncoder.from_pretrained(args.checkpoint).eval()

    rows = [json.loads(ln) for ln in Path(args.board).read_text().splitlines() if ln.strip()]
    acceptable = 0
    unresolved = 0
    tag_hit: Counter[str] = Counter()
    tag_total: Counter[str] = Counter()

    with torch.no_grad():
        for r in rows:
            raw = r["raw"]
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
            ids = out.logits[0].argmax(-1).tolist()[: len(raw)]
            pred = decode_spans(raw, ids)

            # Per-tag exact-match diagnostics vs the board's gold spans.
            gold = {t: raw[s:e] for s, e, t in zip(r["span_starts"], r["span_ends"], r["span_tags"], strict=True)}
            for t, g in gold.items():
                tag_total[t] += 1
                if pred.get(t) == g:
                    tag_hit[t] += 1

            key = norm_key(pred.get("region", "") + "|" + pred.get("locality", ""))
            hit = centroids.get(key)
            if hit is None:
                unresolved += 1
                continue
            if haversine_km(hit[0], hit[1], r["lon"], r["lat"]) <= ACCEPT_KM:
                acceptable += 1

    n = len(rows)
    frac = acceptable / n
    print(f"board rows: {n}; unresolved (pred pair not in table): {unresolved}")
    print("per-tag span exact-match:")
    for t in sorted(tag_total):
        print(f"  {t:<14} {tag_hit[t] / tag_total[t]:.4f}  ({tag_hit[t]}/{tag_total[t]})")
    print(f"\nCOORD-ACCEPTABILITY (<= {ACCEPT_KM} km): {frac:.4f}  ({acceptable}/{n})")
    print(f"GATE >= 0.70: {'PASS' if frac >= 0.70 else 'FAIL'}")


if __name__ == "__main__":
    main()
