"""Build the v8 JP Leg-1 probe shard from Overture-JP (the CJK execution plan, task: probe corpus).

Renders ~200k native space-free JP rows from the on-disk Overture 2026-06-17.0 addresses-jp
parquet (19.59M points, MLIT lineage) into a #519 span-triple corpus the char-mode data loader
consumes directly, plus the municipality-held-out coordinate board and the sealed char vocab (D2).

Pre-registered shape (2026-07-18-v8-jp-char-encoder-design §d):

- STAGE3 universal tags only (D5): region=prefecture, locality=municipality, street=ōaza/chōme
  surface, house_number=the COMPACT number whole-span (D4), postcode on the 〒 fraction.
- Native large-to-small, space-free: ``[〒NNN-NNNN ]{pref}{muni}{street}{number}``. The 〒 mark
  itself stays OUTSIDE the postcode span (symbol prefix, O — the span is the digits, mirroring the
  Latin convention).
- Postcodes: Overture-JP postcode fill is ZERO (re-verified on #473), so the 〒 fraction joins the
  representative postcode from KEN_ALL by NFC/space-stripped (pref, muni) kanji — the lowest code
  per municipality (the NNN-0000 catch-all Japan Post lists first). Same join as
  ``scripts/diagnostic/build-jp-overture-gold.ts``; the pairing's KEN_ALL descent is documented,
  not pretended away.
- Stratified per-prefecture reservoir (47 prefectures, each with its own seeded reservoir), then a
  round-robin draw to the target count — Tokyo cannot drown Tottori.
- Held-out board: municipalities whose bucket hash lands in the board range NEVER appear in
  train/val; board rows carry the gold fields + coordinate for the resolve-side scoring.
- Sanity gates (the JSON-hides-gaps scar): no all-O row, per-char BIO coverage printed, >= 45
  prefectures in train, board∩train municipality overlap must be empty — violations RAISE.

Spans are emitted BY CONSTRUCTION (the raw is concatenated from the labeled fields), which is why
the Phase-0 alignment risk stays retired: there is no search-based re-alignment to drift.

Deviation from the execution plan's "locale-recipe build" note, recorded: the TS locale recipe is
OA-CSV-oriented and the corpus-side ``overture-jp.corpus.jsonl`` drops the prefecture column; this
builder reads the parquet (pyarrow, row-group streaming) in the workspace whose loader consumes the
result. Provenance and licensing follow the parquet's own sources column (OA/MLIT).

Usage:
  uv run python scripts/build_jp_probe_shard.py \
      [--train-rows 200000] [--val-rows 4000] [--board-rows 2000] [--seed 42] \
      [--postcode-fraction 0.30] [--out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-probe]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import unicodedata
from collections import Counter
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from mailwoman_train.char_tokenizer import build_char_vocab, save_char_vocab  # noqa: E402

DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data")
PARQUET = Path(DATA_ROOT) / "overture" / "2026-06-17.0" / "addresses-jp.parquet"
KENALL = Path(DATA_ROOT) / "KEN_ALL_ROME" / "KEN_ALL_ROME.CSV"

SCHEMA = pa.schema(
    [
        ("raw", pa.string()),
        ("tokens", pa.list_(pa.string())),
        ("labels", pa.list_(pa.string())),
        ("span_starts", pa.list_(pa.int32())),
        ("span_ends", pa.list_(pa.int32())),
        ("span_tags", pa.list_(pa.string())),
        ("country", pa.string()),
        ("source", pa.string()),
    ]
)

# Municipality bucket split (md5 of the NFC space-stripped muni kanji, mod 100). Board
# municipalities are UNSEEN by train AND val — the generalization read the gate needs.
BOARD_BUCKET_MIN = 97


def norm_key(s: str) -> str:
    """KEN_ALL join key: NFC + ideographic/ASCII spaces stripped (mirrors build-jp-overture-gold)."""
    return "".join(unicodedata.normalize("NFC", s).split()).replace("　", "")


def load_kenall_postcodes(path: Path) -> dict[str, str]:
    """(pref+muni kanji, normalized) -> representative postcode (first listed = lowest catch-all)."""
    out: dict[str, str] = {}
    text = path.read_bytes().decode("cp932")
    for line in text.splitlines():
        cells = [c.strip('"') for c in line.rstrip("\r\n").split(",")]
        if len(cells) < 6 or len(cells[0]) != 7 or not cells[0].isdigit():
            continue
        key = norm_key(cells[1] + cells[2])
        if key not in out:
            out[key] = cells[0]
    return out


def muni_bucket(muni: str) -> int:
    return int(hashlib.md5(norm_key(muni).encode("utf-8")).hexdigest(), 16) % 100


def render_row(pref: str, muni: str, street: str | None, number: str | None, postcode: str | None) -> dict:
    """Concatenate fields large-to-small, recording each field's span as it lands."""
    raw = ""
    starts: list[int] = []
    ends: list[int] = []
    tags: list[str] = []

    def put(tag: str, text: str) -> None:
        nonlocal raw
        starts.append(len(raw))
        raw += text
        ends.append(len(raw))
        tags.append(tag)

    if postcode:
        raw += "〒"
        put("postcode", f"{postcode[:3]}-{postcode[3:]}")
        raw += " "
    put("region", pref)
    put("locality", muni)
    if street:
        put("street", street)
    if number:
        put("house_number", number)

    # Legacy token columns (unused by the char path, required by the shard schema): whitespace
    # tokens with each token labeled by its first char's span tag — honest at the token grain.
    tokens: list[str] = []
    labels: list[str] = []
    cursor = 0
    for tok in raw.split():
        idx = raw.find(tok, cursor)
        cursor = idx + len(tok)
        label = "O"
        for s, e, t in zip(starts, ends, tags, strict=True):
            if s <= idx < e:
                label = f"B-{t}"
                break
        tokens.append(tok)
        labels.append(label)

    return {
        "raw": raw,
        "tokens": tokens,
        "labels": labels,
        "span_starts": starts,
        "span_ends": ends,
        "span_tags": tags,
        "country": "JP",
        "source": "overture-jp",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default=str(PARQUET))
    ap.add_argument("--kenall", default=str(KENALL))
    ap.add_argument("--out-dir", default=str(Path(DATA_ROOT) / "corpus" / "versioned" / "v8-jp-probe"))
    ap.add_argument("--train-rows", type=int, default=200_000)
    ap.add_argument("--val-rows", type=int, default=4_000)
    ap.add_argument("--board-rows", type=int, default=2_000)
    ap.add_argument("--postcode-fraction", type=float, default=0.30)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    kenall = load_kenall_postcodes(Path(args.kenall))
    print(f"KEN_ALL municipalities: {len(kenall):,}")

    # --- Pass 1: per-prefecture reservoirs (train/val pool) + board reservoir. -----------------
    per_pref_cap = 3 * ((args.train_rows + args.val_rows) // 47)
    pool: dict[str, list[dict]] = {}
    pool_seen: Counter[str] = Counter()
    board_res: list[dict] = []
    board_seen = 0
    dropped = Counter()

    pf = pq.ParquetFile(args.parquet)
    cols = ["address_levels", "street", "number", "lon", "lat"]
    for batch in pf.iter_batches(batch_size=65536, columns=cols):
        levels = batch["address_levels"].to_pylist()
        streets = batch["street"].to_pylist()
        numbers = batch["number"].to_pylist()
        lons = batch["lon"].to_pylist()
        lats = batch["lat"].to_pylist()
        for lv, street, number, lon, lat in zip(levels, streets, numbers, lons, lats, strict=True):
            if not lv or len(lv) < 2 or not lv[0]["value"] or not lv[1]["value"]:
                dropped["levels"] += 1
                continue
            pref, muni = lv[0]["value"], lv[1]["value"]
            if not street and not number:
                dropped["empty"] += 1
                continue
            row = {"pref": pref, "muni": muni, "street": street, "number": number, "lon": lon, "lat": lat}
            if muni_bucket(muni) >= BOARD_BUCKET_MIN:
                board_seen += 1
                if len(board_res) < args.board_rows:
                    board_res.append(row)
                else:
                    j = rng.randrange(board_seen)
                    if j < args.board_rows:
                        board_res[j] = row
            else:
                seen = pool_seen[pref] = pool_seen[pref] + 1
                res = pool.setdefault(pref, [])
                if len(res) < per_pref_cap:
                    res.append(row)
                else:
                    j = rng.randrange(seen)
                    if j < per_pref_cap:
                        res[j] = row
    print(f"prefectures in pool: {len(pool)}; board reservoir: {len(board_res):,} of {board_seen:,} seen")
    print(f"dropped: {dict(dropped)}")

    # --- Round-robin draw to target, then split train/val (val = tail of the shuffled draw). ---
    for res in pool.values():
        rng.shuffle(res)
    order = sorted(pool)
    draw: list[dict] = []
    target = args.train_rows + args.val_rows
    idx = {p: 0 for p in order}
    while len(draw) < target:
        progressed = False
        for p in order:
            if idx[p] < len(pool[p]) and len(draw) < target:
                draw.append(pool[p][idx[p]])
                idx[p] += 1
                progressed = True
        if not progressed:
            break
    rng.shuffle(draw)
    train_rows, val_rows = draw[: args.train_rows], draw[args.train_rows : target]

    # --- Render + write. -----------------------------------------------------------------------
    out_dir = Path(args.out_dir)
    kenall_hit = kenall_miss = 0

    def encode(rows: list[dict], with_postcode: bool) -> list[dict]:
        nonlocal kenall_hit, kenall_miss
        encoded = []
        for r in rows:
            postcode = None
            if with_postcode and rng.random() < args.postcode_fraction:
                postcode = kenall.get(norm_key(r["pref"] + r["muni"]))
                if postcode:
                    kenall_hit += 1
                else:
                    kenall_miss += 1
            encoded.append(render_row(r["pref"], r["muni"], r["street"], r["number"], postcode))
        return encoded

    for split, rows in (("train", train_rows), ("val", val_rows)):
        enc = encode(rows, with_postcode=True)
        (out_dir / split).mkdir(parents=True, exist_ok=True)
        table = pa.Table.from_pylist(enc, schema=SCHEMA)
        pq.write_table(table, out_dir / split / "part-0000.parquet")
        # Sanity: no all-O rows (every row has >= 2 spans by construction), BIO char coverage.
        all_o = sum(1 for e in enc if not e["span_tags"])
        if all_o:
            raise RuntimeError(f"{split}: {all_o} all-O rows — corpus build broken")
        labeled = sum(sum(en - st for st, en in zip(e["span_starts"], e["span_ends"], strict=True)) for e in enc)
        total = sum(len(e["raw"].replace(" ", "").replace("〒", "")) for e in enc)
        print(f"{split}: {len(enc):,} rows; BIO char coverage {labeled / total:.4f}")

    prefs = Counter(r["pref"] for r in train_rows)
    if len(prefs) < 45:
        raise RuntimeError(f"train covers only {len(prefs)} prefectures — stratification broken")
    train_munis = {norm_key(r["muni"]) for r in train_rows} | {norm_key(r["muni"]) for r in val_rows}
    board_munis = {norm_key(r["muni"]) for r in board_res}
    overlap = train_munis & board_munis
    if overlap:
        raise RuntimeError(f"board municipalities leak into train/val: {sorted(overlap)[:5]}")

    board_path = out_dir / "jp-probe-board.jsonl"
    with board_path.open("w", encoding="utf-8") as fh:
        for r in board_res:
            postcode = kenall.get(norm_key(r["pref"] + r["muni"]))
            rendered = render_row(
                r["pref"],
                r["muni"],
                r["street"],
                r["number"],
                postcode if rng.random() < args.postcode_fraction else None,
            )
            fh.write(
                json.dumps(
                    {
                        "raw": rendered["raw"],
                        "span_starts": rendered["span_starts"],
                        "span_ends": rendered["span_ends"],
                        "span_tags": rendered["span_tags"],
                        **r,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    # --- Char vocab (D2): sealed, from the TRAIN split only, min_count=2. ----------------------
    train_table = pq.read_table(out_dir / "train" / "part-0000.parquet", columns=["raw"])
    vocab = build_char_vocab((r for r in train_table["raw"].to_pylist()), min_count=2)
    vocab_path = out_dir / "char-vocab-jp-v1.json"
    save_char_vocab(vocab, vocab_path)

    report = {
        "seed": args.seed,
        "train_rows": len(train_rows),
        "val_rows": len(val_rows),
        "board_rows": len(board_res),
        "prefectures_train": len(prefs),
        "prefecture_min_max": [min(prefs.values()), max(prefs.values())],
        "board_municipalities": len(board_munis),
        "kenall_join": {"hit": kenall_hit, "miss": kenall_miss},
        "char_vocab_size": len(vocab),
        "postcode_fraction": args.postcode_fraction,
        "source_parquet": str(args.parquet),
    }
    (out_dir / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"corpus: {out_dir}")


if __name__ == "__main__":
    main()
