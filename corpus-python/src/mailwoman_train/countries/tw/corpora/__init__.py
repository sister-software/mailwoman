"""Build the Taiwanese training corpus for the character-path CJK model from Overture-TW (#2204 §2).

Source: ``$MAILWOMAN_DATA_ROOT/overture/2026-06-17.0/addresses-tw.parquet`` — 9,732,009 rows, every one with
three ``address_levels`` (縣市 / 鄉鎮市區 / 村里), a ``street`` that already carries the section, lane and alley
(``建國路三段``, ``文建街２０１巷``), a ``number`` (``２９８`` or ``２０１號``) and a ``unit`` that holds the
sub-number and the floor (``之１號``, ``四樓``, ``四樓之２``). The rows come from the civil-affairs bureaus of 15
of Taiwan's 22 縣市 through OpenAddresses (CC BY 4.0), redistributed by Overture under CDLA-Permissive-2.0; the
build report lists the 15 agencies from the parquet's ``sources.dataset`` column, which the model card carries
because the Taiwanese license voids the grant on a missing attribution.

Measured over a 1,486,679-row sample (12 of the row groups): street ends in 巷 33%, 路 23%, 街 16%, 段 13%, 弄 12%;
``number`` is ``N號`` in 89% and a bare ``N`` in 11%; ``unit`` is empty in 39%, a sub-number ``之N號`` in 6%, a floor
(``三樓`` … ``七樓``) or a floor plus sub-number in the rest. No row carries a postcode (Chunghwa Post's 3+3 codes
carry no distribution grant, so none is built here either).

Labels, under the ``stage3-cjk`` head with NO new tag, mirroring the Korean choice of one tag per WOF placetype:

    縣市      → region              (WOF ``region``, 22 of 22 keyed)
    鄉鎮市區  → subregion           (WOF ``county`` for 234 of them, ``localadmin`` for 111 — the resolver ladder reads both)
    村里      → dependent_locality
    street    → street              (路 / 段 / 巷 / 弄 stay INSIDE the span: they are the street's own name)
    number + 之N sub-number → house_number, with the 號 designator inside the span (``298之1號``)
    floor     → unit                (``四樓``, ``四樓之2``)

Registers (weights renormalized over what a row can render; the build report says what landed):

    official     高雄市鳳山區忠義里中山西路２９８之１號       the household-registration form: full-width digits, the 里 present
    no_village   高雄市鳳山區中山西路298之1號               how it is typed: no 里, ASCII digits
    spaced       高雄市 鳳山區 中山西路 298之1號             the same with spaces between the units
    no_region    鳳山區中山西路298之1號                     the 縣市 dropped, the district carrying the row
    with_unit    高雄市鳳山區中山西路298之1號四樓            the floor appended (only rows that have one)

Held-out 鄉鎮市區 (the board) are chosen by the same stable hash rule as the JP and KR boards, at the KR share
(``--board-bucket-min 90``, about one district in ten); train and val are stratified over the 縣市 by water-filling.
The board carries the row's own coordinate; a per-district centroid table (mean of every source row) is written
beside it so the JP scorer reads the coordinate half with ``--resolve-tags region,subregion``.

Two modules, the same division as the Japanese and Korean builders: `rows` reads the parquet and renders one row
in one register, `assemble` runs the MEASURING pass and the SELECTING pass and writes the slice.

Usage:
    python -m mailwoman_train.countries.tw.corpora --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-tw-<date>
"""

from __future__ import annotations

from .assemble import (
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
    BOARD_BUCKET_MIN,
    COUNTRY,
    COUNTRY_NAMES,
    LABEL_SET_NAME,
    PARQUET_PARTS,
    REGISTER_WEIGHTS,
    SOURCE,
    SourceRow,
    available_registers,
    choose_register,
    iter_source_rows,
    render_row,
    split_number_unit,
    verify_record,
)

__all__ = [
    "BOARD_BUCKET_MIN",
    "COUNTRY",
    "COUNTRY_NAMES",
    "LABEL_SET_NAME",
    "PARQUET_PARTS",
    "REGISTER_WEIGHTS",
    "SOURCE",
    "RowEncoder",
    "Selection",
    "SourceRow",
    "SourceSurvey",
    "available_registers",
    "build",
    "check_stratification",
    "choose_register",
    "iter_source_rows",
    "main",
    "parse_args",
    "render_row",
    "select_rows",
    "split_number_unit",
    "survey_source",
    "verify_record",
    "write_board",
    "write_splits",
]
