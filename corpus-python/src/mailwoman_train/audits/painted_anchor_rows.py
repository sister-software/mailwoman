"""Count the corpus rows the anchor painter PAINTS, per lookup.

A zero here is not a smaller number: it is the anchor channel being switched off for a country while
the config still sets ``use_postcode_anchor: true``. Run it before a launch, once per recipe output
whose country you expect the anchor to serve. A zero on a recipe output you expected to paint is a
stop rather than a warning — either the lookup lacks that country's keys or the key normalization
diverged.

It runs the training encoder's own anchor painter (`mailwoman_mtf.RowEncoder` with ``anchor_paint_mode: shaped``)
with one piece per character, so the anchor confidence it returns is the per-character paint before the
projection onto pieces. The projection copies per-character values onto pieces, so it cannot turn a painted row
into an unpainted one.

    python -m mailwoman_train.audits.painted_anchor_rows \\
      --lookup $MAILWOMAN_DATA_ROOT/anchor/staging-2026-08-05/pilot-anchor-lookup-v2-2026-08-05.json \\
      --jsonl $MAILWOMAN_DATA_ROOT/corpus/slices/synth-gb-v1.jsonl \\
      --limit 100000

Exits non-zero when a JSONL file paints zero rows (``--allow-zero`` to survey instead of refuse).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import mailwoman_mtf
import spliterator

from ..data.loader.encode import row_encoder

#: The longest row the audit paints. The audit passes one piece per character, so the encoder's width bounds the
#: row's length.
MAX_ROW_CHARACTERS = 2048


def count_painted_rows(jsonl: Path, encoder: mailwoman_mtf.RowEncoder, limit: int | None) -> dict[str, int]:
    """Walk one JSONL recipe output and count rows by what the painter does to them."""
    stats = {"rows": 0, "shaped": 0, "painted": 0, "spans": 0, "spans_hit": 0, "gold_postcode": 0}
    for row in spliterator.read_jsonl(jsonl, take=limit):
        raw = row.get("raw") or ""
        if len(raw) > MAX_ROW_CHARACTERS:
            raise ValueError(f"{jsonl}: a row has {len(raw)} characters, over the audit's {MAX_ROW_CHARACTERS}")
        stats["rows"] += 1
        if (row.get("components") or {}).get("postcode"):
            stats["gold_postcode"] += 1

        spans = encoder.shaped_postcode_spans(raw)
        if spans:
            stats["shaped"] += 1
        stats["spans"] += len(spans)

        pieces = [[(0, i, i + 1) for i in range(len(raw))]]
        confidence = encoder.encode_batch([{"raw": raw, "tokens": [], "labels": []}], pieces=pieces)[
            "anchor_confidence"
        ][0]
        stats["spans_hit"] += sum(1 for start, end in spans if confidence[start:end].any())
        if confidence.any():
            stats["painted"] += 1
    return stats


def letter_key_count(lookup_path: str) -> tuple[int, int]:
    """The lookup's keys that hold an ASCII capital letter, and all its keys."""
    with open(lookup_path, encoding="utf-8") as fh:
        keys = json.load(fh).keys()
    return sum(1 for k in keys if any("A" <= c <= "Z" for c in k)), len(keys)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lookup", required=True, help="anchor lookup JSON (the config's anchor_lookup_path)")
    ap.add_argument("--jsonl", required=True, action="append", help="JSONL recipe output; repeatable")
    ap.add_argument("--limit", type=int, default=None, help="rows per JSONL file (default: all)")
    ap.add_argument("--allow-zero", action="store_true", help="survey mode — do not fail on a zero")
    args = ap.parse_args()

    encoder = row_encoder(
        None, max_length=MAX_ROW_CHARACTERS, pad_id=0, anchor_lookup_path=args.lookup, anchor_paint_mode="shaped"
    )
    letters, keys = letter_key_count(args.lookup)
    print(f"lookup {args.lookup}")
    print(f"  keys {keys:,}   letter-containing {letters:,}")

    zeroes: list[str] = []
    for jsonl_path in args.jsonl:
        jsonl = Path(jsonl_path)
        stats = count_painted_rows(jsonl, encoder, args.limit)
        rows = stats["rows"] or 1
        print(f"\n{jsonl.name}  rows {stats['rows']:,}")
        print(f"  gold postcode component : {stats['gold_postcode']:,} ({100 * stats['gold_postcode'] / rows:.1f}%)")
        print(f"  shape-detected a span   : {stats['shaped']:,} ({100 * stats['shaped'] / rows:.1f}%)")
        print(f"  PAINTED (lookup hit)    : {stats['painted']:,} ({100 * stats['painted'] / rows:.1f}%)")
        print(f"  spans {stats['spans']:,}  spans that hit the lookup {stats['spans_hit']:,}")
        if stats["painted"] == 0:
            zeroes.append(jsonl.name)

    if zeroes and not args.allow_zero:
        print(f"\nZERO PAINTED ROWS on: {', '.join(zeroes)} — the anchor channel is OFF for this recipe output.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
