"""Build the v8 JP Leg-1 probe slice from Overture-JP (the CJK execution plan, task: probe corpus).

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
- Sanity checks (the JSON-hides-gaps scar): no all-O row, per-char BIO coverage printed, >= 45
  prefectures in train, board∩train municipality overlap must be empty — violations RAISE.

Spans are emitted BY CONSTRUCTION (the raw is concatenated from the labeled fields), which is why
the Phase-0 alignment risk stays retired: there is no search-based re-alignment to drift.

Deviation from the execution plan's "locale-recipe build" note, recorded: the TS locale recipe is
OA-CSV-oriented and the corpus-side ``overture-jp.corpus.jsonl`` drops the prefecture column; this
builder reads the parquet (pyarrow, row-group streaming) in the workspace whose loader consumes the
result. Provenance and licensing follow the parquet's own sources column (OA/MLIT).

Usage:
  python -m mailwoman_train.countries.jp.probe_corpora \
      [--train-rows 200000] [--val-rows 4000] [--board-rows 2000] [--seed 42] \
      [--postcode-fraction 0.30] [--out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-probe]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from ...paths import data_root_path
from ...tokenizer.char import build_char_vocab, save_char_vocab

#: Resolved when a default is needed, not at import, so `--help` runs with no data root configured.
PARQUET_PARTS = ("overture", "2026-06-17.0", "addresses-jp.parquet")
KENALL_PARTS = ("KEN_ALL_ROME", "KEN_ALL_ROME.CSV")
OUT_DIR_PARTS = ("corpus", "versioned", "v8-jp-probe")

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

# The canonical 47 prefectures. Overture address_levels[0] carries occasional junk variants
# ("東京都1", 2 rows of 19.6M) — anything outside this set is dropped and counted.
JP_PREFECTURES = frozenset(
    "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 "
    "新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 "
    "奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 "
    "熊本県 大分県 宮崎県 鹿児島県 沖縄県".split()
)

# Municipality bucket split (md5 of the NFC space-stripped muni kanji, mod 100). Board
# municipalities are UNSEEN by train AND val — the generalization read the check needs.
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
    # md5 is a stable bucketing hash here, never a security digest (bandit B324).
    return int(hashlib.md5(norm_key(muni).encode("utf-8"), usedforsecurity=False).hexdigest(), 16) % 100


def render_row(pref: str, muni: str, street: str | None, number: str | None, postcode: str | None) -> dict[str, Any]:
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

    # Legacy token columns (unused by the char path, required by the slice schema): whitespace
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


@dataclass
class Reservoirs:
    """What one pass over the parquet keeps: the per-prefecture pool and the held-out board.

    Both are reservoir samples drawn from the same `random.Random`, so the two branches consume
    draws in the order the rows arrive. Splitting the pass in two — board first, pool second —
    would sample different addresses from the same seed.
    """

    pool: dict[str, list[dict[str, Any]]]
    board: list[dict[str, Any]]
    board_seen: int
    dropped: Counter[str]


@dataclass
class PostcodeJoin:
    """The KEN_ALL join as it ran: the counts the build report carries."""

    hit: int = 0
    miss: int = 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(PARQUET_PARTS))
    ap.add_argument("--kenall", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(KENALL_PARTS))
    ap.add_argument("--out-dir", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(OUT_DIR_PARTS))
    ap.add_argument("--train-rows", type=int, default=200_000)
    ap.add_argument("--val-rows", type=int, default=4_000)
    ap.add_argument("--board-rows", type=int, default=2_000)
    ap.add_argument("--postcode-fraction", type=float, default=0.30)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)
    args.parquet = args.parquet or str(data_root_path(*PARQUET_PARTS))
    args.kenall = args.kenall or str(data_root_path(*KENALL_PARTS))
    args.out_dir = args.out_dir or str(data_root_path(*OUT_DIR_PARTS))
    return args


def fill_reservoirs(args: argparse.Namespace, rng: random.Random) -> Reservoirs:
    """One streaming pass over the parquet, filling both reservoirs.

    Each prefecture carries its OWN reservoir so Tokyo cannot drown Tottori, capped at three times
    a prefecture's share of the target. A municipality whose bucket lands in the board range goes
    to the board instead, which is what keeps board municipalities unseen by train and val.
    """
    per_pref_cap = 3 * ((args.train_rows + args.val_rows) // 47)
    pool: dict[str, list[dict[str, Any]]] = {}
    pool_seen: Counter[str] = Counter()
    board_res: list[dict[str, Any]] = []
    board_seen = 0
    dropped: Counter[str] = Counter()

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
            if pref not in JP_PREFECTURES:
                dropped["junk_prefecture"] += 1
                continue
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
    return Reservoirs(pool=pool, board=board_res, board_seen=board_seen, dropped=dropped)


def draw_splits(
    args: argparse.Namespace, pool: dict[str, list[dict[str, Any]]], rng: random.Random
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Round-robin across prefectures to the target, then split train/val off the shuffled draw.

    Round-robin is what makes the draw stratified: each pass takes one row from every prefecture
    that still has one, so a prefecture's share is its supply rather than its population.
    """
    for res in pool.values():
        rng.shuffle(res)
    order = sorted(pool)
    draw: list[dict[str, Any]] = []
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
    return draw[: args.train_rows], draw[args.train_rows : target]


def encode_rows(
    rows: list[dict[str, Any]],
    *,
    kenall: dict[str, str],
    join: PostcodeJoin,
    rng: random.Random,
    postcode_fraction: float,
) -> list[dict[str, Any]]:
    """Render each row, joining a postcode onto the configured fraction of them.

    The coin is drawn BEFORE the lookup and for every row, so a municipality KEN_ALL does not cover
    still consumes its draw — the row order a seeded build produces does not depend on the join's
    hit rate.
    """
    encoded = []
    for r in rows:
        postcode = None
        if rng.random() < postcode_fraction:
            postcode = kenall.get(norm_key(r["pref"] + r["muni"]))
            if postcode:
                join.hit += 1
            else:
                join.miss += 1
        encoded.append(render_row(r["pref"], r["muni"], r["street"], r["number"], postcode))
    return encoded


def write_splits(
    out_dir: Path,
    splits: tuple[tuple[str, list[dict[str, Any]]], ...],
    *,
    kenall: dict[str, str],
    join: PostcodeJoin,
    rng: random.Random,
    postcode_fraction: float,
) -> None:
    """Write each split's parquet, and RAISE rather than ship a corpus the checks fail.

    An all-O row cannot occur by construction — the raw is concatenated from the labeled fields —
    so one means the build is broken rather than the data thin. The printed char coverage is the
    JSON-hides-gaps guard: a fraction well under 1 says spans stopped covering the raw.
    """
    for split, rows in splits:
        enc = encode_rows(rows, kenall=kenall, join=join, rng=rng, postcode_fraction=postcode_fraction)
        (out_dir / split).mkdir(parents=True, exist_ok=True)
        table = pa.Table.from_pylist(enc, schema=SCHEMA)
        pq.write_table(table, out_dir / split / "part-0000.parquet")
        all_o = sum(1 for e in enc if not e["span_tags"])
        if all_o:
            raise RuntimeError(f"{split}: {all_o} all-O rows — corpus build broken")
        labeled = sum(sum(en - st for st, en in zip(e["span_starts"], e["span_ends"], strict=True)) for e in enc)
        total = sum(len(e["raw"].replace(" ", "").replace("〒", "")) for e in enc)
        print(f"{split}: {len(enc):,} rows; BIO char coverage {labeled / total:.4f}")


def check_stratification(
    train_rows: list[dict[str, Any]], val_rows: list[dict[str, Any]], board: list[dict[str, Any]]
) -> tuple[Counter[str], set[str]]:
    """RAISE on a train split missing a prefecture, or on a board municipality that leaks into it.

    Both failures produce a corpus that still trains and a board that still scores — the board
    would just be measuring memorization, which is the one thing it exists to rule out.
    """
    prefs = Counter(r["pref"] for r in train_rows)
    if len(prefs) != 47:
        raise RuntimeError(f"train covers {len(prefs)} prefectures, expected exactly 47 — stratification broken")
    train_munis = {norm_key(r["muni"]) for r in train_rows} | {norm_key(r["muni"]) for r in val_rows}
    board_munis = {norm_key(r["muni"]) for r in board}
    overlap = train_munis & board_munis
    if overlap:
        raise RuntimeError(f"board municipalities leak into train/val: {sorted(overlap)[:5]}")
    return prefs, board_munis


def write_board(
    out_dir: Path,
    board: list[dict[str, Any]],
    *,
    kenall: dict[str, str],
    rng: random.Random,
    postcode_fraction: float,
) -> None:
    """Write the held-out board: the rendered row plus the gold fields the resolve side scores against."""
    board_path = out_dir / "jp-probe-board.jsonl"
    with board_path.open("w", encoding="utf-8") as fh:
        for r in board:
            postcode = kenall.get(norm_key(r["pref"] + r["muni"]))
            rendered = render_row(
                r["pref"],
                r["muni"],
                r["street"],
                r["number"],
                postcode if rng.random() < postcode_fraction else None,
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


def seal_char_vocab(out_dir: Path) -> dict[str, int]:
    """Build the char vocabulary from the TRAIN split alone, at min_count=2.

    Reading it back off the written parquet rather than from the in-memory rows is what makes it
    sealed against the split that ships: a vocabulary built from val or board would let a character
    the model never trained on carry an id.
    """
    train_table = pq.read_table(out_dir / "train" / "part-0000.parquet", columns=["raw"])
    vocab = build_char_vocab((r for r in train_table["raw"].to_pylist()), min_count=2)
    save_char_vocab(vocab, out_dir / "char-vocab-jp-v1.json")
    return vocab


def main() -> None:
    args = parse_args()
    rng = random.Random(args.seed)
    kenall = load_kenall_postcodes(Path(args.kenall))
    print(f"KEN_ALL municipalities: {len(kenall):,}")

    reservoirs = fill_reservoirs(args, rng)
    train_rows, val_rows = draw_splits(args, reservoirs.pool, rng)

    out_dir = Path(args.out_dir)
    join = PostcodeJoin()
    write_splits(
        out_dir,
        (("train", train_rows), ("val", val_rows)),
        kenall=kenall,
        join=join,
        rng=rng,
        postcode_fraction=args.postcode_fraction,
    )
    prefs, board_munis = check_stratification(train_rows, val_rows, reservoirs.board)
    write_board(out_dir, reservoirs.board, kenall=kenall, rng=rng, postcode_fraction=args.postcode_fraction)
    vocab = seal_char_vocab(out_dir)

    report = {
        "seed": args.seed,
        "train_rows": len(train_rows),
        "val_rows": len(val_rows),
        "board_rows": len(reservoirs.board),
        "prefectures_train": len(prefs),
        "prefecture_min_max": [min(prefs.values()), max(prefs.values())],
        "board_municipalities": len(board_munis),
        "kenall_join": {"hit": join.hit, "miss": join.miss},
        "char_vocab_size": len(vocab),
        "postcode_fraction": args.postcode_fraction,
        "source_parquet": str(args.parquet),
    }
    (out_dir / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"corpus: {out_dir}")


if __name__ == "__main__":
    main()
