"""Build the FULL JP training shard from Overture-JP (v8 CJK Phase 3, epic #1176).

The Leg-1 probe shard (``scripts/build_jp_probe_shard.py``, 200k rows) proved the char path on the
universal STAGE3 subset: coordinate-acceptability **0.9925 vs the pre-registered 0.70 gate**. Phase 3
is the full shard the probe's PASS unlocked, and it differs from the probe in four ways:

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
  the ``NNN-0000`` catch-all — every probe postcode ended in four zeros. This shard joins at TOWN
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

    python -m mailwoman_train.build_jp_shard \\
        --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-full-2026-08-04 \\
        --train-rows 2000000 --val-rows 20000 --board-rows 20000

    # smoke slice (first N row groups, small targets — the rung below a full build)
    python -m mailwoman_train.build_jp_shard --out-dir /tmp/jp-smoke \\
        --max-row-groups 4 --train-rows 20000 --val-rows 1000 --board-rows 1000
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import unicodedata
from collections import Counter
from collections.abc import Iterable, Iterator, Sequence
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from .char_tokenizer import build_char_vocab, save_char_vocab
from .labels import resolve_label_set
from .tokenizer import char_label_array_from_spans

DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "/mnt/playpen/mailwoman-data")
DEFAULT_PARQUET = Path(DATA_ROOT) / "overture" / "2026-06-17.0" / "addresses-jp.parquet"
DEFAULT_KENALL = Path(DATA_ROOT) / "KEN_ALL_ROME" / "KEN_ALL_ROME.CSV"

LABEL_SET_NAME = "stage3-jp"

# The shard schema. ``register`` is an addition over the probe's eight columns: the loader reads an
# explicit column list, so an extra column is inert at train time and lets the Phase-4 board report
# per-register acceptability instead of one blended number.
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
        ("register", pa.string()),
    ]
)

# Same source string as the probe shard. An unlisted source is DROPPED by ``source_weights``, so a
# new name would silently empty the feed of any config that names the probe's — the corpus_dir
# already distinguishes the two shards.
SOURCE = "overture-jp"

# The canonical 47. Overture's address_levels[0] carries occasional junk ("東京都1"); the full pass
# counted 48 distinct values, so exactly one junk variant survives into 19.6M rows. Dropped + counted.
JP_PREFECTURES = frozenset(
    "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 "
    "新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 "
    "奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 "
    "熊本県 大分県 宮崎県 鹿児島県 沖縄県".split()
)

# Municipality bucket split, IDENTICAL to the probe (md5 of the NFC space-stripped kanji, mod 100,
# board at >= 97). Keeping the rule byte-identical means the probe's held-out board municipalities
# stay held out here — a Phase-4 model can be graded on the Leg-1 board without leakage.
BOARD_BUCKET_MIN = 97

# Budget for one row's field values (prefecture + municipality + street + number). The char model
# runs at S=96 units and ``encode_row_units`` truncates past that SILENTLY, so the shard must not
# contain a row that cannot fit. 64 leaves 32 characters of headroom for everything rendering adds:
# 〒NNN-NNNN + space (10), 日本 (2), three separator spaces, and the designator register's kanji.
# Measured distribution: median rendered row is 18 characters, so this cuts far out in the tail.
MAX_FIELD_CHARS = 64

# The hard invariant the guard above exists to produce. Violation RAISES — reaching it means the
# field budget stopped bounding the rendered length, which is a code defect, not tail data.
MAX_RENDERED_CHARS = 96

# --- Normalization: the corpus-side subset of the Phase-3 steal list -----------------------------

# Hyphen-equivalence class. Applied to the NUMBER field only (see the module docstring): U+30FC and
# U+FF70 are prolonged-sound marks that belong inside katakana names, and folding them there would
# corrupt the name. In a banchi-go they are a typed hyphen.
_HYPHEN_CLASS = "‐‑‒–—―−ー﹘﹣－ｰ"
_HYPHEN_TABLE = str.maketrans({c: "-" for c in _HYPHEN_CLASS})

# The variant hyphens a real keyboard/IME emits, for the robustness fraction. U+30FC is the one a
# Japanese IME produces when the user hits the key next to 0 in kana mode.
VARIANT_HYPHENS = ("ー", "−", "－")

_KANJI_DIGITS = {"〇": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_ARABIC_DIGITS = "〇一二三四五六七八九"

_CHOME_TAIL = re.compile(r"^(.*?)([0-9０-９〇一二三四五六七八九十百]+)丁目$")
_COMPACT = re.compile(r"^[0-9]+(?:-[0-9]+)*$")
_SOURCE_DESIGNATOR = re.compile(r"^([0-9]+)番地?([0-9]+)号$")


def fold_halfwidth_kana(text: str) -> str:
    """Fold half-width katakana (U+FF61–FF9F) to full width, composing the dakuten.

    Targeted, not blanket NFKC: NFKC would also fold full-width digits to ASCII, and the two-register
    chōme convention needs those registers kept apart. The fold is LENGTH-CHANGING (ﾃﾞ → デ, 2 chars
    → 1), which is safe here only because it runs on field values BEFORE they are concatenated and
    their spans recorded. 14,739 ``number`` values in the source need it.
    """
    if not any(0xFF61 <= ord(c) <= 0xFF9F for c in text):
        return text
    folded = "".join(unicodedata.normalize("NFKC", c) if 0xFF61 <= ord(c) <= 0xFF9F else c for c in text)
    return unicodedata.normalize("NFC", folded)


def normalize_name(text: str) -> str:
    """Normalize a NAME field (prefecture / municipality / street): NFC + kana fold + de-space.

    ALL whitespace is removed, interior included. 135 street values carry an ideographic space
    (``西与賀町　字今津乙``) which is a rendering artifact of the source, not part of the name — the
    written form closes it up, and leaving it in put a U+3000 inside a ``district`` span (found by
    counting labelled chars against significant chars on the first full build: coverage read
    1.000001, which is how a six-row defect announces itself).

    Explicitly does not touch hyphens (U+30FC is a real katakana character here) and does not fold
    itaiji (the MJ縮退マップ tables are CC BY-SA — see the module docstring).
    """
    return "".join(fold_halfwidth_kana(unicodedata.normalize("NFC", text)).split())


def normalize_number(text: str) -> str:
    """Normalize a NUMBER field: NFC + half-width kana fold + the hyphen-equivalence class."""
    return fold_halfwidth_kana(unicodedata.normalize("NFC", text)).translate(_HYPHEN_TABLE).strip()


def kanji_to_int(text: str) -> int | None:
    """Parse a JP numeral (either register) to an int. Returns None if it is not one.

    Handles the forms a chōme actually takes: bare digits (ASCII or full-width), the digit-string
    kanji register (〇一二…), and the positional kanji register up to 百 (一丁目 … 二十三丁目).
    """
    if not text:
        return None
    ascii_form = unicodedata.normalize("NFKC", text)
    if ascii_form.isdigit():
        return int(ascii_form)
    if all(c in _KANJI_DIGITS for c in text):
        return int("".join(str(_KANJI_DIGITS[c]) for c in text))
    total = 0
    current = 0
    for char in text:
        if char == "十":
            current = (current or 1) * 10
            total += current
            current = 0
        elif char == "百":
            current = (current or 1) * 100
            total += current
            current = 0
        elif char in _KANJI_DIGITS:
            current = _KANJI_DIGITS[char]
        else:
            return None
    return total + current


def int_to_kanji(value: int) -> str:
    """Render an int in the positional kanji register (the register the source's 丁目 uses)."""
    if value < 0:
        raise ValueError(f"negative chōme: {value}")
    if value < 10:
        return _ARABIC_DIGITS[value]
    if value < 100:
        tens, ones = divmod(value, 10)
        return ("" if tens == 1 else _ARABIC_DIGITS[tens]) + "十" + (_ARABIC_DIGITS[ones] if ones else "")
    hundreds, rest = divmod(value, 100)
    head = ("" if hundreds == 1 else _ARABIC_DIGITS[hundreds]) + "百"
    return head + (int_to_kanji(rest) if rest else "")


def split_street(street: str) -> tuple[str, int | None]:
    """Split an Overture ``street`` value into (district, chōme number or None).

    ``八島町二丁目`` → ``("八島町", 2)``; ``字崎枝`` → ``("字崎枝", None)``; ``二丁目`` → ``("", 2)``.
    A non-trailing 丁目 (2,316 rows) is left whole as the district — re-rendering a form we have not
    read is how a corpus grows labels nobody verified.
    """
    match = _CHOME_TAIL.match(street)
    if not match:
        return street, None
    value = kanji_to_int(match.group(2))
    if value is None:
        return street, None
    return match.group(1), value


# --- Row rendering -------------------------------------------------------------------------------

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
}


class RowRenderer:
    """Concatenate normalized field values large-to-small, recording each span as it lands."""

    def __init__(self) -> None:
        self.raw = ""
        self.starts: list[int] = []
        self.ends: list[int] = []
        self.tags: list[str] = []

    def put(self, tag: str, text: str) -> None:
        if not text:
            return
        self.starts.append(len(self.raw))
        self.raw += text
        self.ends.append(len(self.raw))
        self.tags.append(tag)

    def glue(self, text: str) -> None:
        """Append unlabeled text (the 〒 mark, a separating space) — it stays outside every span."""
        self.raw += text


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
) -> dict:
    """Render one JP row in one register, returning the #519 span-triple shard record.

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
    # Legacy token columns (the char path ignores them; the shard schema requires them): whitespace
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


def available_registers(chome: int | None, number: str) -> tuple[str, ...]:
    """Which registers a row can honestly render.

    A row with no chōme has no chōme register to convert; a number that is not a clean part list
    (``362B-2``, ``761乙号-2`` — 103,299 rows) cannot be re-rendered as designators at all, so it
    stays whole-span in its native surface.
    """
    clean = bool(_COMPACT.match(number)) if number else False
    if not clean:
        return ("native",)
    if chome is None:
        return ("native", "designator")
    return tuple(REGISTER_WEIGHTS)


def choose_register(rng: random.Random, options: Sequence[str]) -> str:
    if len(options) == 1:
        return options[0]
    weights = [REGISTER_WEIGHTS[name] for name in options]
    return rng.choices(options, weights=weights, k=1)[0]


# --- Source reading ------------------------------------------------------------------------------


def norm_key(text: str) -> str:
    """KEN_ALL join key: NFC + ideographic/ASCII spaces stripped (the probe's key, unchanged)."""
    return "".join(unicodedata.normalize("NFC", text).split()).replace("　", "")


def muni_bucket(municipality: str) -> int:
    return int(hashlib.md5(norm_key(municipality).encode("utf-8")).hexdigest(), 16) % 100


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
        head = norm_key(prefecture + municipality)
        if district:
            hit = self.town.get(head + norm_key(district))
            if hit:
                return hit, "town"
            stripped = _AZA_PREFIX.sub("", district)
            if stripped != district:
                hit = self.town.get(head + norm_key(stripped))
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
        head = norm_key(cells[1] + cells[2])
        municipality.setdefault(head, cells[0])
        name = _KENALL_PAREN.sub("", cells[3]).strip()
        if not name or name == _KENALL_CATCH_ALL:
            continue
        town.setdefault(head + norm_key(name), cells[0])
    return KenAllIndex(town, municipality)


def iter_source_rows(
    parquet: Path,
    max_row_groups: int | None = None,
    max_field_chars: int = MAX_FIELD_CHARS,
    dropped: Counter | None = None,
) -> Iterator[tuple]:
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


def select_exact(count: int, quota: int, rng: random.Random) -> Iterator[bool]:
    """Stream an exact ``quota``-of-``count`` selection mask (O(1) memory, seeded, no reservoir)."""
    remaining_quota = min(quota, count)
    remaining = count
    for _ in range(count):
        take = remaining_quota > 0 and rng.random() < remaining_quota / remaining
        if take:
            remaining_quota -= 1
        remaining -= 1
        yield take


def water_fill(counts: dict[str, int], target: int) -> int:
    """Largest per-prefecture cap whose total is <= target (so Tokyo cannot drown Tottori)."""
    if not counts:
        return 0
    low, high = 0, max(counts.values())
    while low < high:
        mid = (low + high + 1) // 2
        if sum(min(mid, n) for n in counts.values()) <= target:
            low = mid
        else:
            high = mid - 1
    return low


# --- Verification --------------------------------------------------------------------------------


def verify_record(record: dict, tag_set: frozenset[str]) -> None:
    """Re-validate one rendered record through the TRAINING consumer, not through its own author.

    Five independent checks, each of which has a scar behind it: the row fits S=96 so the loader
    never truncates it silently, no span holds whitespace (an interior U+3000 in a source name field
    put one inside a ``district``), every span slices its own text (the build_secondary_shard
    self-check), every tag is in the active label set (a tag outside it collapses to ``O`` at load —
    silent, #1349), and the triple survives ``char_label_array_from_spans``, the function the char
    path actually calls.
    """
    raw = record["raw"]
    if not record["span_tags"]:
        raise RuntimeError(f"all-O row: {raw!r}")
    if len(raw) > MAX_RENDERED_CHARS:
        raise RuntimeError(f"row of {len(raw)} chars exceeds S={MAX_RENDERED_CHARS} and would truncate: {raw!r}")
    for start, end, tag in zip(record["span_starts"], record["span_ends"], record["span_tags"], strict=True):
        if tag not in tag_set:
            raise RuntimeError(f"tag {tag!r} is outside {LABEL_SET_NAME} — it would collapse to O at load")
        if not raw[start:end]:
            raise RuntimeError(f"empty span {tag}@[{start},{end}) in {raw!r}")
        if any(character.isspace() for character in raw[start:end]):
            raise RuntimeError(f"whitespace inside span {tag}@[{start},{end}): {raw[start:end]!r}")
    char_label_array_from_spans(raw, record["span_starts"], record["span_ends"], record["span_tags"])


def coverage_stats(records: Iterable[dict]) -> dict:
    """The BIO coverage the eval protocol asks for — counted on the LABEL ARRAY, not on the JSON.

    ``JSON hides gaps``: a span triple can look complete while the array the model reads is mostly
    ``O``. So this walks ``char_label_array_from_spans`` output, the same array the loader builds.
    """
    per_tag_rows: Counter[str] = Counter()
    per_tag_spans: Counter[str] = Counter()
    per_tag_chars: Counter[str] = Counter()
    per_label: Counter[str] = Counter()
    registers: Counter[str] = Counter()
    labeled = total = total_significant = rows = 0
    lengths: list[int] = []
    for record in records:
        rows += 1
        registers[record["register"]] += 1
        raw = record["raw"]
        lengths.append(len(raw))
        array = char_label_array_from_spans(raw, record["span_starts"], record["span_ends"], record["span_tags"])
        for label in array:
            per_label[label] += 1
        total += len(raw)
        total_significant += sum(1 for c in raw if not c.isspace() and c != "〒")
        labeled += sum(1 for label in array if label != "O")
        for tag in set(record["span_tags"]):
            per_tag_rows[tag] += 1
        for start, end, tag in zip(record["span_starts"], record["span_ends"], record["span_tags"], strict=True):
            per_tag_spans[tag] += 1
            per_tag_chars[tag] += end - start
    lengths.sort()
    return {
        "rows": rows,
        "bio_char_coverage_all": round(labeled / total, 6) if total else 0.0,
        "bio_char_coverage_significant": round(labeled / total_significant, 6) if total_significant else 0.0,
        "raw_len_min_median_max": [lengths[0], lengths[len(lengths) // 2], lengths[-1]] if lengths else None,
        "registers": dict(registers.most_common()),
        "per_tag_rows": dict(per_tag_rows.most_common()),
        "per_tag_spans": dict(per_tag_spans.most_common()),
        "per_tag_chars": dict(per_tag_chars.most_common()),
        "per_label_chars": dict(per_label.most_common()),
    }


# --- Build ---------------------------------------------------------------------------------------


def build(args: argparse.Namespace) -> dict:
    rng = random.Random(args.seed)
    tag_set = frozenset(resolve_label_set(LABEL_SET_NAME).tags)
    kenall = load_kenall_postcodes(Path(args.kenall))
    parquet = Path(args.parquet)

    # --- Pass 1: exact eligible counts per prefecture + board pool (no rows retained). -----------
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
    # got longer — surface it rather than quietly shipping a differently-composed shard.
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
    # the shard hits its row count exactly rather than "about".
    if shortfall > 0:
        for prefecture in sorted(pool_counts, key=lambda p: pool_counts[p] - quotas[p], reverse=True):
            headroom = pool_counts[prefecture] - quotas[prefecture]
            grant = min(headroom, shortfall)
            quotas[prefecture] += grant
            shortfall -= grant
            if shortfall <= 0:
                break
    print(f"pass 1: per-prefecture cap {cap:,}; quota total {sum(quotas.values()):,} of target {target:,}")

    # --- Pass 2: exact selection, streamed. ------------------------------------------------------
    selectors = {p: select_exact(pool_counts[p], quotas[p], rng) for p in pool_counts}
    board_selector = select_exact(board_count, args.board_rows, rng)
    selected: list[tuple] = []
    board: list[tuple] = []
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

    kenall_tiers: Counter[str] = Counter()
    register_unavailable: Counter[str] = Counter()

    def encode(rows: Sequence[tuple]) -> list[dict]:
        out: list[dict] = []
        for prefecture, municipality, street, number, _lon, _lat in rows:
            district, chome = split_street(street)
            options = available_registers(chome, number)
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
            )
            verify_record(record, tag_set)
            out.append(record)
        return out

    out_dir = Path(args.out_dir)
    if out_dir.exists() and any(out_dir.iterdir()) and not args.force:
        raise SystemExit(
            f"{out_dir} exists and is non-empty — pass --force to overwrite (a shard is a read-only artifact)"
        )

    splits: dict[str, dict] = {}
    for split, source_rows in (("train", train_source), ("val", val_source)):
        (out_dir / split).mkdir(parents=True, exist_ok=True)
        stats_input: list[dict] = []
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

    # --- Held-out board (same municipality rule as the probe; rendered across registers). --------
    board_path = out_dir / "jp-board.jsonl"
    board_records: list[dict] = []
    with board_path.open("w", encoding="utf-8") as handle:
        for prefecture, municipality, street, number, lon, lat in board:
            district, chome = split_street(street)
            register = choose_register(rng, available_registers(chome, number))
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

    # --- Sanity gates. Violations RAISE; a shard that fails one is not a shard. -------------------
    train_prefectures = {row[0] for row in train_source}
    if args.max_row_groups is None and len(train_prefectures) != 47:
        raise RuntimeError(f"train covers {len(train_prefectures)} prefectures, expected 47 — stratification broken")
    train_munis = {norm_key(row[1]) for row in train_source} | {norm_key(row[1]) for row in val_source}
    board_munis = {norm_key(row[1]) for row in board}
    overlap = train_munis & board_munis
    if overlap:
        raise RuntimeError(f"board municipalities leak into train/val: {sorted(overlap)[:5]}")

    # --- Char vocab (D2): sealed, rebuilt from the TRAIN split only, min_count=2. -----------------
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
        "splits": splits,
        "board_coverage": coverage_stats(board_records),
    }
    (out_dir / "build-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--parquet", default=str(DEFAULT_PARQUET))
    parser.add_argument("--kenall", default=str(DEFAULT_KENALL))
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
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true", help="overwrite a non-empty --out-dir")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    build(parse_args(argv))


if __name__ == "__main__":
    main()
