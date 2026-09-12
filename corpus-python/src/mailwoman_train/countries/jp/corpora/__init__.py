"""Build the FULL JP training slice from Overture-JP (v8 CJK Phase 3, epic #1176).

The Leg-1 probe slice (``probe_corpora.py`` beside this package, 200k rows) proved the char path on
the universal STAGE3 subset: coordinate-acceptability **0.9925 vs the pre-registered 0.70 check**.
Phase 3 is the full slice the probe's PASS unlocked, and it differs from the probe in four ways:

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
  ``data.loader.iter_encoded`` RAISES if any channel path is set alongside ``char_mode`` — channels
  project per SP-piece and their per-unit re-alignment is Phase 4 by the encoder design. The loader
  enforces that ordering; this builder respects it.
- **``building_name``.** The tag is declared in ``stage3-jp`` and gets ZERO support from this source:
  Overture-JP carries no venue or building name column (``unit`` is 100% NULL). A tag with no rows is
  a gap the report names rather than a gap a synthesizer invents.

The modules:

- `rows.py` — rendering one address in one register, and verifying the record.
- `sources.py` — reading the Overture parquet and the KEN_ALL postcode join.
- `assemble.py` — the two passes, the encoder, the writers and the report. Named for what it does
  rather than `build.py`, because this package re-exports a FUNCTION called `build` and the two
  names cannot both answer to `corpora.build`.
"""

from __future__ import annotations

from .assemble import (
    BOARD_BUCKET_MIN,
    RowEncoder,
    Selection,
    SourceSurvey,
    build,
    check_stratification,
    main,
    parse_args,
    select_rows,
    survey_source,
    write_board,
    write_splits,
)
from .rows import (
    LABEL_SET_NAME,
    REGISTER_WEIGHTS,
    SOURCE,
    available_registers,
    choose_register,
    render_row,
    verify_record,
)
from .sources import (
    ADMIN_DB_PARTS,
    KENALL_PARTS,
    PARQUET_PARTS,
    KenAllIndex,
    iter_source_rows,
    load_kenall_postcodes,
)

__all__ = [
    "ADMIN_DB_PARTS",
    "BOARD_BUCKET_MIN",
    "KENALL_PARTS",
    "LABEL_SET_NAME",
    "PARQUET_PARTS",
    "REGISTER_WEIGHTS",
    "SOURCE",
    "KenAllIndex",
    "RowEncoder",
    "Selection",
    "SourceSurvey",
    "available_registers",
    "build",
    "check_stratification",
    "choose_register",
    "iter_source_rows",
    "load_kenall_postcodes",
    "main",
    "parse_args",
    "render_row",
    "select_rows",
    "survey_source",
    "verify_record",
    "write_board",
    "write_splits",
]
