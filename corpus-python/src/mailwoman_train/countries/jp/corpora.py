"""Build the FULL JP training slice from Overture-JP (v8 CJK Phase 3, epic #1176).

The Leg-1 probe slice (``scripts/build_jp_probe_slice.py``, 200k rows) proved the char path on the
universal STAGE3 subset: coordinate-acceptability **0.9925 vs the pre-registered 0.70 check**. Phase 3
is the full slice the probe's PASS unlocked, and it differs from the probe in four ways:

1. **JP-native labels** (``label_set: stage3-jp``, 47 BIO — activated by #1357). The probe mapped
   prefecture→``region`` / municipality→``locality`` / the whole ōaza-chōme surface→``street``.
   Here the admin ladder gets its own tags (``prefecture`` / ``municipality`` / ``district``) and the
   chōme is split off as ``block``, because 丁目 is a designator carried in the surface — the same
   two-surface rule D4 states for numbers.
2. **Both number registers.** D4: a COMPACT number (``2-3-16``) is ONE ``house_number`` span (the
   part→role mapping is resolve-time arithmetic, not per-token evidence); the long designator form
   (``3番16号``) carries its designators in the surface, so it splits into ``sub_block`` /
   ``building_number``. The corpus must contain both, because a user types both.
3. **Both chōme registers, one of which the source does not contain.** Measured over all 19,587,926
   rows: the ``street`` column writes chōme with KANJI numerals in 3,139,164 of 3,139,164 cases
   (0 ASCII), and the ``number`` column is a 2-part ``N-N`` banchi-go in 19,480,990 of them (the
   3-part compact ``2-3-16`` NEVER appears — the chōme lives in ``street``). Train on the source
   register alone and the model never sees ``2丁目`` or ``八島町2-3-16``, both of which are ordinary
   typed Japanese. Those registers are synthesized here, from the same fields, with spans by
   construction.
4. **A rebuilt char vocab.** The probe's 200k rows yielded 1,918 characters; the full surface carries
   2,381 distinct (2,360 at min_count=2) — a 463-character tail that is exactly the proper-noun kanji
   an address parser exists for.

Spans are emitted BY CONSTRUCTION (the raw string is concatenated from labeled field values, each
span recorded as it lands), which is why Phase-0's alignment risk stays retired: there is no
search-based re-alignment to drift. Every row is then re-validated through the training consumer
itself (``tokenizer.char_label_array_from_spans``) before it is written.

Measured facts this recipe rests on (full pass, 238 s, 2026-08-04 — put the number in so the next
reader can tell whether the constraint still binds):

- 19,587,926 rows; ``address_levels`` is length 2 in **every** row (prefecture, municipality). There
  is no district level in the data — ``district`` has to come out of the ``street`` column.
- street: 16,374,515 plain · 3,139,164 trailing-丁目 · 71,922 carrying 条 (the Sapporo grid, real) ·
  2,316 with a non-trailing 丁目 · 1,500 chōme with no district prefix · 9 empty.
  地割 (Iwate) and 無番地 appear **zero** times — two of the steal list's named tail forms are simply
  not in this source, so nothing is built for them here.
- number: 19,480,990 compact ``N-N`` · 103,299 other (``362B-2``, ``761乙号-2``) of which 14,739 need
  a half-width-kana fold · 3,637 already in a kanji-designator form.
- ``postcode`` and ``unit`` are 100% NULL (Overture-JP postcode fill is zero, re-verified #473), so
  the 〒 fraction joins KEN_ALL. The probe joined at MUNICIPALITY granularity, which always returns
  the ``NNN-0000`` catch-all — every probe postcode ended in four zeros. This slice joins at TOWN
  granularity first (see ``KenAllIndex``): 17.8% exact, 89.6% once a leading ``字``/``大字`` is
  stripped, remainder on the municipality catch-all, zero misses.
- Exactly 2 distinct non-BMP characters occur (𨦻 ×109, 𨫤 ×25). Python string offsets are
  code-point-native and so is the training consumer, so these need no special handling HERE; the #519
  scar applies to the TS decode path (Phase 5), not to this builder.

**Deliberately NOT done here**, so nobody "finishes the job" wrongly:

- **Itaiji / variant folding** (辺邊邉, 舘館, ヶケが, 之ノの, 新字体↔旧字体). The canonical tables are
  MJ縮退マップ, CC BY-SA 2.1 JP — share-alike, a real constraint on shipping a derived table
  (tokenizer-CJK prior-art synthesis, "JP dictionary licensing"). Fold nothing we cannot ship.
- **The hyphen-equivalence class in NAME fields.** U+30FC (ー) is a legitimate character inside a
  katakana place name; folding it to ``-`` everywhere corrupts the name. It is folded in the
  ``number`` field only, where it is unambiguously a typed hyphen.
- **Channel wiring.** The road map lists "postcode-anchor channel wiring" under Phase 3, but
  ``data_loader.iter_encoded`` RAISES if any channel path is set alongside ``char_mode`` — channels
  project per SP-piece and their per-unit re-alignment is Phase 4 by the encoder design. The loader
  enforces that ordering; this builder respects it.
- **``building_name``.** The tag is declared in ``stage3-jp`` and gets ZERO support from this source:
  Overture-JP carries no venue or building name column (``unit`` is 100% NULL). A tag with no rows is
  a gap the report names rather than a gap a synthesizer invents.

Usage::

    python -m mailwoman_train.countries.jp.corpora \\
        --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-full-2026-08-04 \\
        --train-rows 2000000 --val-rows 20000 --board-rows 20000

    # smoke slice (first N row groups, small targets — the rung below a full build)
    python -m mailwoman_train.countries.jp.corpora --out-dir /tmp/jp-smoke \\
        --max-row-groups 4 --train-rows 20000 --val-rows 1000 --board-rows 1000
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from ...corpora.builder import (
    MAX_FIELD_CHARS,
    SCHEMA,
    RowRenderer,
    coverage_stats,
    muni_bucket,
    select_exact,
    water_fill,
)
from ...corpora.builder import verify_record as _verify_record
from ...labels import resolve_label_set
from ...paths import resolve_data_root_default
from ...text.kana import int_to_kanji
from ...text.normalize import normalize_text
from ...tokenizer.char import build_char_vocab, save_char_vocab
from .kana import municipality_kana_from_admin_db, municipality_kana_lookup
from .text import JP_PREFECTURES, VARIANT_HYPHENS, normalize_name, normalize_number, split_street

#: Where each input sits under `$MAILWOMAN_DATA_ROOT`. Resolved after parsing, not here: reading the
#: root at import would raise for a caller who passes the flag and never needs it.
PARQUET_PARTS = ("overture", "2026-06-17.0", "addresses-jp.parquet")
KENALL_PARTS = ("KEN_ALL_ROME", "KEN_ALL_ROME.CSV")
ADMIN_DB_PARTS = ("wof", "admin-global-priority.db")

LABEL_SET_NAME = "stage3-jp"

# Same source string as the probe slice. An unlisted source is DROPPED by ``source_weights``, so a
# new name would silently empty the feed of any config that names the probe's — the corpus_dir
# already distinguishes the two slices.
SOURCE = "overture-jp"

# Municipality bucket split, IDENTICAL to the probe (md5 of the NFC space-stripped kanji, mod 100,
# board at >= 97). Keeping the rule byte-identical means the probe's held-out board municipalities
# stay held out here — a Phase-4 model can be graded on the Leg-1 board without leakage.
BOARD_BUCKET_MIN = 97

# endregion

_COMPACT = re.compile(r"^[0-9]+(?:-[0-9]+)*$")
_SOURCE_DESIGNATOR = re.compile(r"^([0-9]+)番地?([0-9]+)号$")

# region Row rendering

# The registers. Weights are renormalized over whatever is AVAILABLE for a row (a street with no
# chōme cannot render `arabic_chome` or `compact_folded`), and the build report prints the counts
# that actually landed rather than the intent.
REGISTER_WEIGHTS: dict[str, float] = {
    # The source's own surface: kanji chōme + compact banchi-go. The postal-official register.
    "native": 0.40,
    # 二丁目 → 2丁目. Ubiquitous in typed input and ABSENT from the source (0 of 3,139,164).
    "arabic_chome": 0.25,
    # Chōme folded into the number: 八島町2-3-16. This is D4's named compact form, and the 3-part
    # compact number appears in ZERO source rows — only synthesis puts it in front of the model.
    "compact_folded": 0.20,
    # 3番16号 — designators in the surface, so the JP-seven number tags fire (D4's two-surface rule).
    "designator": 0.15,
    # あつぎ市 — the municipality as its kana reading plus the kanji generic (#2165): the shape of the official kana
    # names (かすみがうら市) that two from-scratch runs failed to close at the 市. Native rendering otherwise.
    # Available only where the admin DB reads the municipality (jp_kana.py).
    "kana_municipality": 0.05,
}


def render_row(
    *,
    prefecture: str,
    municipality: str,
    district: str,
    chome: int | None,
    number: str,
    postcode: str | None,
    register: str,
    spaced: bool,
    country: bool,
    hyphen: str = "-",
    municipality_kana: str | None = None,
) -> dict[str, Any]:
    """Render one JP row in one register, returning the #519 span-triple slice record.

    Order is native large-to-small and space-free by default (``spaced`` inserts single ASCII spaces
    between the admin components, which real typed input does carry). The 〒 mark stays OUTSIDE the
    postcode span — the span is the digits, mirroring the Latin convention.
    """
    renderer = RowRenderer()
    sep = " " if spaced else ""

    if postcode:
        renderer.glue("〒")
        renderer.put("postcode", f"{postcode[:3]}-{postcode[3:]}")
        renderer.glue(" ")
    if country:
        renderer.put("country", "日本")
        renderer.glue(sep)
    renderer.put("prefecture", prefecture)
    renderer.glue(sep)
    if register == "kana_municipality":
        if not municipality_kana:
            raise ValueError("kana_municipality register needs municipality_kana")
        renderer.put("municipality", municipality_kana)
    else:
        renderer.put("municipality", municipality)
    renderer.glue(sep)

    parts = number.split("-") if number else []

    if register == "compact_folded":
        # The chōme becomes the leading part of one whole-span house_number (D4).
        renderer.put("district", district)
        renderer.put("house_number", hyphen.join([str(chome), *parts]))
    elif register == "designator":
        renderer.put("district", district)
        if chome is not None:
            renderer.put("block", f"{int_to_kanji(chome)}丁目")
        if len(parts) >= 2:
            renderer.put("sub_block", f"{parts[0]}番")
            renderer.put("building_number", f"{parts[1]}号")
            for extra in parts[2:]:
                renderer.put("house_number", extra)
        elif parts:
            renderer.put("sub_block", f"{parts[0]}番地")
    else:
        renderer.put("district", district)
        if chome is not None:
            block = f"{chome}丁目" if register == "arabic_chome" else f"{int_to_kanji(chome)}丁目"
            renderer.put("block", block)
        if number:
            renderer.put("house_number", hyphen.join(parts) if parts else number)

    raw = renderer.raw
    # Legacy token columns (the char path ignores them; the slice schema requires them): whitespace
    # tokens labeled by the span covering their first character — honest at the token grain.
    tokens: list[str] = []
    labels: list[str] = []
    cursor = 0
    for token in raw.split():
        index = raw.find(token, cursor)
        cursor = index + len(token)
        label = "O"
        for start, end, tag in zip(renderer.starts, renderer.ends, renderer.tags, strict=True):
            if start <= index < end:
                label = f"B-{tag}"
                break
        tokens.append(token)
        labels.append(label)

    return {
        "raw": raw,
        "tokens": tokens,
        "labels": labels,
        "span_starts": renderer.starts,
        "span_ends": renderer.ends,
        "span_tags": renderer.tags,
        "country": "JP",
        "source": SOURCE,
        "register": register,
    }


def available_registers(chome: int | None, number: str, kana: bool = False) -> tuple[str, ...]:
    """Which registers a row can honestly render.

    A row with no chōme has no chōme register to convert; a number that is not a clean part list
    (``362B-2``, ``761乙号-2`` — 103,299 rows) cannot be re-rendered as designators at all, so it
    stays whole-span in its native surface. ``kana`` says whether the municipality has a kana
    reading to render (#2165); without one the kana register is not on offer.
    """
    clean = bool(_COMPACT.match(number)) if number else False
    kana_extra = ("kana_municipality",) if kana else ()
    if not clean:
        return ("native", *kana_extra)
    if chome is None:
        return ("native", "designator", *kana_extra)
    return tuple(name for name in REGISTER_WEIGHTS if kana or name != "kana_municipality")


def choose_register(rng: random.Random, options: Sequence[str]) -> str:
    if len(options) == 1:
        return options[0]
    weights = [REGISTER_WEIGHTS[name] for name in options]
    return rng.choices(options, weights=weights, k=1)[0]


# endregion

# region Source reading


_KENALL_PAREN = re.compile(r"[（(].*?[）)]")
_KENALL_CATCH_ALL = "以下に掲載がない場合"
_AZA_PREFIX = re.compile(r"^(大字|字)")


class KenAllIndex:
    """The 〒 join: TOWN-level first, municipality catch-all only as the fallback.

    The probe joined at municipality granularity, which always returns the ``NNN-0000`` catch-all
    Japan Post lists first — so every probe row carried a postcode whose last four digits were
    ``0000``. Real Japanese postcodes are town-level, and KEN_ALL carries the town (``大字`` /
    ``町``) in column 4. Joining there instead makes the trailing digits real.

    The join needs one correction that is worth the measurement it took: Overture writes the ōaza
    prefix (``字崎枝``, ``大字上田``) and KEN_ALL does not. Exact town match alone hits **17.8%**
    of rows; retrying with a leading ``字``/``大字`` stripped takes it to **89.6%** (200k-row slice,
    2026-08-04). The remaining 10.4% falls back to the municipality catch-all, and nothing misses.
    """

    def __init__(self, town: dict[str, str], municipality: dict[str, str]) -> None:
        self.town = town
        self.municipality = municipality

    def lookup(self, prefecture: str, municipality: str, district: str) -> tuple[str | None, str]:
        """Return ``(postcode, tier)`` where tier ∈ town | town_aza_stripped | municipality | miss."""
        head = normalize_text(prefecture + municipality)
        if district:
            hit = self.town.get(head + normalize_text(district))
            if hit:
                return hit, "town"
            stripped = _AZA_PREFIX.sub("", district)
            if stripped != district:
                hit = self.town.get(head + normalize_text(stripped))
                if hit:
                    return hit, "town_aza_stripped"
        hit = self.municipality.get(head)
        return (hit, "municipality") if hit else (None, "miss")


def load_kenall_postcodes(path: Path) -> KenAllIndex:
    """Read KEN_ALL_ROME (cp932) into the two-tier index above.

    Column layout: ``postcode, prefecture-kanji, city-kanji, town-kanji, …romaji``. Town names carry
    parenthetical annotations (``大通東（１～１３丁目）``) that are stripped, and the literal
    ``以下に掲載がない場合`` ("if not listed below") is the municipality catch-all, not a town.
    """
    town: dict[str, str] = {}
    municipality: dict[str, str] = {}
    for line in path.read_bytes().decode("cp932").splitlines():
        cells = [cell.strip('"') for cell in line.rstrip("\r\n").split(",")]
        if len(cells) < 6 or len(cells[0]) != 7 or not cells[0].isdigit():
            continue
        head = normalize_text(cells[1] + cells[2])
        municipality.setdefault(head, cells[0])
        name = _KENALL_PAREN.sub("", cells[3]).strip()
        if not name or name == _KENALL_CATCH_ALL:
            continue
        town.setdefault(head + normalize_text(name), cells[0])
    return KenAllIndex(town, municipality)


def iter_source_rows(
    parquet: Path,
    max_row_groups: int | None = None,
    max_field_chars: int = MAX_FIELD_CHARS,
    dropped: Counter[str] | None = None,
) -> Iterator[tuple[str, str, str, str, float, float]]:
    """Yield ``(prefecture, municipality, street, number, lon, lat)`` for every eligible source row.

    Eligibility, and why each rule exists — all four counts measured over the full 19,587,926 rows:

    - both address levels present + the prefecture in the canonical 47 (2 junk rows);
    - at least one of street/number non-empty (9 rows);
    - the number carries no comma (**35 rows**). Those are MLIT parcel AGGREGATIONS —
      ``岡山町1154,1153,1155,…`` up to 256 characters against a single coordinate. Rendered, they
      become one ``house_number`` span sixty parcels long, which is not a house number in any
      register a user types;
    - the field total fits ``max_field_chars`` (24 rows carry a number longer than 24 chars). This
      is the STRUCTURAL guard behind the semantic one: the char path runs at S=96 units and
      ``encode_row_units`` truncates silently, so a row that cannot fit is dropped here, counted,
      rather than half-labelled there.

    The filter lives in the iterator so BOTH passes see the identical row set — a filter applied
    only in pass 2 would desynchronize the exact-selection masks.

    Normalization happens here for the same reason.
    """
    handle = pq.ParquetFile(parquet)
    groups = (
        handle.metadata.num_row_groups
        if max_row_groups is None
        else min(max_row_groups, handle.metadata.num_row_groups)
    )
    columns = ["address_levels", "street", "number", "lon", "lat"]
    for index in range(groups):
        table = handle.read_row_group(index, columns=columns)
        levels = table["address_levels"].to_pylist()
        streets = table["street"].to_pylist()
        numbers = table["number"].to_pylist()
        lons = table["lon"].to_pylist()
        lats = table["lat"].to_pylist()
        for level, street, number, lon, lat in zip(levels, streets, numbers, lons, lats, strict=True):
            if not level or len(level) < 2:
                if dropped is not None:
                    dropped["levels"] += 1
                continue
            prefecture, municipality = level[0]["value"], level[1]["value"]
            if not prefecture or not municipality or prefecture not in JP_PREFECTURES:
                if dropped is not None:
                    dropped["junk_prefecture"] += 1
                continue
            if not street and not number:
                if dropped is not None:
                    dropped["empty"] += 1
                continue
            if number and "," in number:
                if dropped is not None:
                    dropped["parcel_list_number"] += 1
                continue
            street = normalize_name(street) if street else ""
            number = normalize_number(number) if number else ""
            if len(prefecture) + len(municipality) + len(street) + len(number) > max_field_chars:
                if dropped is not None:
                    dropped["too_long"] += 1
                continue
            yield (
                prefecture,
                municipality,
                street,
                number,
                lon,
                lat,
            )


# endregion

# region Verification


def verify_record(record: dict[str, Any], tag_set: frozenset[str]) -> None:
    """The shared verifier bound to this corpus's label set."""
    _verify_record(record, tag_set, label_set_name=LABEL_SET_NAME)


# endregion

# region Build


def build(args: argparse.Namespace) -> dict[str, Any]:
    rng = random.Random(args.seed)
    tag_set = frozenset(resolve_label_set(LABEL_SET_NAME).tags)
    kenall = load_kenall_postcodes(Path(args.kenall))
    parquet = Path(args.parquet)

    # endregion

    # region Pass 1: exact eligible counts per prefecture + board pool (no rows retained).
    pool_counts: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    board_count = 0
    scanned = 0
    for prefecture, municipality, _street, _number, _lon, _lat in iter_source_rows(
        parquet, args.max_row_groups, args.max_field_chars, dropped
    ):
        scanned += 1
        if muni_bucket(municipality) >= BOARD_BUCKET_MIN:
            board_count += 1
        else:
            pool_counts[prefecture] += 1
    print(f"pass 1: {scanned:,} eligible rows · {len(pool_counts)} prefectures · board pool {board_count:,}")
    print(f"pass 1: dropped {dict(dropped)}")
    # A drop rate this filter was not designed for means the source changed shape, not that the tail
    # got longer — surface it rather than quietly shipping a differently-composed slice.
    drop_rate = sum(dropped.values()) / max(scanned + sum(dropped.values()), 1)
    if drop_rate > 0.02:
        raise RuntimeError(
            f"source drop rate {drop_rate:.4f} exceeds 2% — the eligibility filter no longer fits the data"
        )

    target = args.train_rows + args.val_rows
    cap = water_fill(pool_counts, target)
    quotas = {prefecture: min(cap, count) for prefecture, count in pool_counts.items()}
    shortfall = target - sum(quotas.values())
    # Water-filling lands at or below target; hand the remainder to the prefectures with headroom so
    # the slice hits its row count exactly rather than "about".
    if shortfall > 0:
        for prefecture in sorted(pool_counts, key=lambda p: pool_counts[p] - quotas[p], reverse=True):
            headroom = pool_counts[prefecture] - quotas[prefecture]
            grant = min(headroom, shortfall)
            quotas[prefecture] += grant
            shortfall -= grant
            if shortfall <= 0:
                break
    print(f"pass 1: per-prefecture cap {cap:,}; quota total {sum(quotas.values()):,} of target {target:,}")

    # endregion

    # region Pass 2: exact selection, streamed.
    selectors = {p: select_exact(pool_counts[p], quotas[p], rng) for p in pool_counts}
    board_selector = select_exact(board_count, args.board_rows, rng)
    selected: list[tuple[str, str, str, str, float, float]] = []
    board: list[tuple[str, str, str, str, float, float]] = []
    for row in iter_source_rows(parquet, args.max_row_groups, args.max_field_chars):
        if muni_bucket(row[1]) >= BOARD_BUCKET_MIN:
            if next(board_selector):
                board.append(row)
        elif next(selectors[row[0]]):
            selected.append(row)
    print(f"pass 2: selected {len(selected):,} pool rows · {len(board):,} board rows")

    rng.shuffle(selected)
    train_source = selected[: args.train_rows]
    val_source = selected[args.train_rows : args.train_rows + args.val_rows]

    # Attested-row weight (#2178): a municipality NAME shape the head under-serves — 市 inside a 町 / 村 name
    # (市川三郷町, 市貝町, 余市町, 高市郡…) — is five municipalities and 21,043 of 19,587,889 source rows, about 0.1% of
    # train after selection. `--upweight-pattern REGEX:K` appends K-1 further copies of every selected train row
    # whose municipality matches, each rendered in its own draw of register, so the shape reaches the head at
    # K× its natural share without a synthetic name. Val and the board are untouched, so the read stays honest.
    upweighted = 0
    if args.upweight_pattern:
        pattern_text, _, factor_text = args.upweight_pattern.rpartition(":")
        pattern = re.compile(pattern_text)
        factor = int(factor_text)
        matching = [row for row in train_source if pattern.search(row[1])]
        for _ in range(factor - 1):
            train_source.extend(matching)
        upweighted = len(matching) * (factor - 1)
        rng.shuffle(train_source)
        print(
            f"upweight {pattern_text!r} ×{factor}: {len(matching):,} matching train rows, {upweighted:,} copies appended"
        )

    kenall_tiers: Counter[str] = Counter()
    register_unavailable: Counter[str] = Counter()
    kana_by_municipality = municipality_kana_from_admin_db(args.admin_db) if args.admin_db else {}
    print(f"[jp] kana readings for {len(kana_by_municipality):,} municipalities (#2165)", file=sys.stderr)

    def encode(rows: Sequence[tuple[str, str, str, str, float, float]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for prefecture, municipality, street, number, _lon, _lat in rows:
            district, chome = split_street(street)
            municipality_kana = municipality_kana_lookup(kana_by_municipality, municipality)
            options = available_registers(chome, number, kana=municipality_kana is not None)
            register_unavailable["full" if len(options) == len(REGISTER_WEIGHTS) else "reduced"] += 1
            register = choose_register(rng, options)
            postcode = None
            if rng.random() < args.postcode_fraction:
                postcode, tier = kenall.lookup(prefecture, municipality, district)
                kenall_tiers[tier] += 1
            hyphen = rng.choice(VARIANT_HYPHENS) if rng.random() < args.variant_hyphen_fraction else "-"
            record = render_row(
                prefecture=prefecture,
                municipality=municipality,
                district=district,
                chome=chome,
                number=number,
                postcode=postcode,
                register=register,
                spaced=rng.random() < args.spaced_fraction,
                country=rng.random() < args.country_fraction,
                hyphen=hyphen,
                municipality_kana=municipality_kana,
            )
            verify_record(record, tag_set)
            out.append(record)
        return out

    out_dir = Path(args.out_dir)
    if out_dir.exists() and any(out_dir.iterdir()) and not args.force:
        raise SystemExit(
            f"{out_dir} exists and is non-empty — pass --force to overwrite (a slice is a read-only artifact)"
        )

    splits: dict[str, dict[str, Any]] = {}
    for split, source_rows in (("train", train_source), ("val", val_source)):
        (out_dir / split).mkdir(parents=True, exist_ok=True)
        stats_input: list[dict[str, Any]] = []
        part = 0
        written = 0
        for start in range(0, len(source_rows), args.rows_per_part):
            chunk = encode(source_rows[start : start + args.rows_per_part])
            table = pa.Table.from_pylist(chunk, schema=SCHEMA)
            pq.write_table(table, out_dir / split / f"part-{part:04d}.parquet")
            part += 1
            written += len(chunk)
            # Coverage is computed on a bounded sample per part so a 2M-row build stays memory-flat.
            stats_input.extend(chunk[: args.stats_sample_per_part])
        splits[split] = {"rows": written, "parts": part, "coverage": coverage_stats(stats_input)}
        print(
            f"{split}: {written:,} rows in {part} parts; "
            f"BIO char coverage {splits[split]['coverage']['bio_char_coverage_significant']:.4f}"
        )

    # endregion

    # region Held-out board (same municipality rule as the probe; rendered across registers).
    board_path = out_dir / "jp-board.jsonl"
    board_records: list[dict[str, Any]] = []
    with board_path.open("w", encoding="utf-8") as handle:
        for prefecture, municipality, street, number, lon, lat in board:
            district, chome = split_street(street)
            municipality_kana = municipality_kana_lookup(kana_by_municipality, municipality)
            register = choose_register(rng, available_registers(chome, number, kana=municipality_kana is not None))
            postcode = None
            if rng.random() < args.postcode_fraction:
                postcode, tier = kenall.lookup(prefecture, municipality, district)
                kenall_tiers[tier] += 1
            record = render_row(
                prefecture=prefecture,
                municipality=municipality,
                district=district,
                chome=chome,
                number=number,
                postcode=postcode,
                register=register,
                spaced=rng.random() < args.spaced_fraction,
                country=rng.random() < args.country_fraction,
                municipality_kana=municipality_kana,
            )
            verify_record(record, tag_set)
            board_records.append(record)
            handle.write(
                json.dumps(
                    {
                        "raw": record["raw"],
                        "span_starts": record["span_starts"],
                        "span_ends": record["span_ends"],
                        "span_tags": record["span_tags"],
                        "register": record["register"],
                        "pref": prefecture,
                        "muni": municipality,
                        "street": street,
                        "number": number,
                        "lon": lon,
                        "lat": lat,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    # endregion

    # region Sanity checks. Violations RAISE; a slice that fails one is not a slice.
    train_prefectures = {row[0] for row in train_source}
    if args.max_row_groups is None and len(train_prefectures) != 47:
        raise RuntimeError(f"train covers {len(train_prefectures)} prefectures, expected 47 — stratification broken")
    train_munis = {normalize_text(row[1]) for row in train_source} | {normalize_text(row[1]) for row in val_source}
    board_munis = {normalize_text(row[1]) for row in board}
    overlap = train_munis & board_munis
    if overlap:
        raise RuntimeError(f"board municipalities leak into train/val: {sorted(overlap)[:5]}")

    # endregion

    # region Char vocab (D2): sealed, rebuilt from the TRAIN split only, min_count=2.
    def train_raws() -> Iterator[str]:
        for path in sorted((out_dir / "train").glob("*.parquet")):
            table = pq.read_table(path, columns=["raw"])
            yield from table["raw"].to_pylist()

    vocab = build_char_vocab(train_raws(), min_count=2)
    save_char_vocab(vocab, out_dir / "char-vocab-jp-full.json")

    report = {
        "seed": args.seed,
        "source_parquet": str(parquet),
        "kenall": str(args.kenall),
        "label_set": LABEL_SET_NAME,
        "source": SOURCE,
        "eligible_rows_scanned": scanned,
        "dropped_at_source": dict(dropped.most_common()),
        "max_field_chars": args.max_field_chars,
        "per_prefecture_cap": cap,
        "prefectures_train": len(train_prefectures),
        "board_municipalities": len(board_munis),
        "board_rows": len(board_records),
        "kenall_join_tiers": dict(kenall_tiers.most_common()),
        "register_availability": dict(register_unavailable),
        "char_vocab_size": len(vocab),
        "fractions": {
            "postcode": args.postcode_fraction,
            "country": args.country_fraction,
            "spaced": args.spaced_fraction,
            "variant_hyphen": args.variant_hyphen_fraction,
        },
        "register_weights": REGISTER_WEIGHTS,
        "upweight": {"pattern": args.upweight_pattern, "copies_appended": upweighted},
        "splits": splits,
        "board_coverage": coverage_stats(board_records),
    }
    (out_dir / "build-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--parquet", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(PARQUET_PARTS))
    parser.add_argument("--kenall", default=None, help="defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(KENALL_PARTS))
    parser.add_argument(
        "--admin-db",
        default=None,
        help=(
            "WOF admin DB for the municipality kana readings (#2165); an empty string disables the register. "
            "Defaults to $MAILWOMAN_DATA_ROOT/" + "/".join(ADMIN_DB_PARTS)
        ),
    )
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--train-rows", type=int, default=2_000_000)
    parser.add_argument("--val-rows", type=int, default=20_000)
    parser.add_argument("--board-rows", type=int, default=20_000)
    parser.add_argument("--rows-per-part", type=int, default=250_000)
    parser.add_argument("--stats-sample-per-part", type=int, default=50_000)
    parser.add_argument("--postcode-fraction", type=float, default=0.30)
    parser.add_argument("--country-fraction", type=float, default=0.10)
    parser.add_argument("--spaced-fraction", type=float, default=0.12)
    parser.add_argument("--variant-hyphen-fraction", type=float, default=0.05)
    parser.add_argument("--max-field-chars", type=int, default=MAX_FIELD_CHARS)
    parser.add_argument(
        "--max-row-groups", type=int, default=None, help="smoke slice: read only the first N row groups"
    )
    parser.add_argument(
        "--upweight-pattern",
        default=None,
        metavar="REGEX:K",
        help="append K-1 copies of every selected train row whose municipality matches REGEX (#2178)",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true", help="overwrite a non-empty --out-dir")
    args = parser.parse_args(argv)
    args.parquet = resolve_data_root_default(args.parquet, *PARQUET_PARTS)
    args.kenall = resolve_data_root_default(args.kenall, *KENALL_PARTS)
    # An explicit empty string disables the register, so only `None` means "use the default".
    if args.admin_db is None:
        args.admin_db = resolve_data_root_default(None, *ADMIN_DB_PARTS)
    return args


def main(argv: Sequence[str] | None = None) -> None:
    build(parse_args(argv))


if __name__ == "__main__":
    main()
