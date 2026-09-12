"""Build the Korean training corpus for the character-path CJK model from the road-name address register (#2204 §1, §5).

Two sources, two output corpora, one label set (``stage3-cjk``, no new tag):

**The LABEL corpus** (``--out-dir``, source ``juso-kr``) renders the ministry's 주소DB — 6,424,089 road-name addresses
with their representative lot, postcode and building name (`juso.py`) — in seven registers:

    official        서울특별시 종로구 자하문로 94 (청운동)             the register's own form, the 법정동 (or 리) in parentheses
    building        서울특별시 종로구 송월길 99 (홍파동, 경희궁자이)   the official form with the building name after the 동
    no_dong         서울특별시 종로구 자하문로 94                     how it is typed
    postcode_first  03047 서울특별시 종로구 자하문로 94               the delivery form
    short_region    서울시 종로구 자하문로 94                         the spoken region (서울 / 경기 / 충북 …)
    unspaced        서울특별시종로구자하문로94                         a search box, no spaces
    jibun           서울특별시 종로구 청운동 52-1                     the lot-number form, still the one half of Korea writes

    REGION → region, 시군구 → subregion (two adjacent spans for `수원시 장안구`), 읍/면 and 법정동/리 → dependent_locality,
    road → street, building number and lot number → house_number, postcode → postcode, building name → venue.

**The registry corpus** (``--registry-out-dir``, source ``localdata-kr``) is the NOISY half: every open business in
the permit registry (`registers.py`), each row carrying both address forms as a clerk typed them, aligned against
the LABEL register's own key sets and kept only when the whole key matches. The alignment rate is measured per form
and per category and written to the build report BEFORE the rows are selected. A permit string that does not align
is a board row (``kr-registry-board.jsonl``), never a training row.

The board is the held-out set of 시군구 (the same stable hash rule as the JP and TW boards, one in ten). The register
carries no coordinate, so the board's coordinate half is the permit registry's: every permit row's EPSG:5174 point is
projected through GDAL and averaged per 시군구, and the LABEL board row carries its 시군구's centroid, which is what
the JP scorer compares a resolved (region, subregion) pair against. Permit rows in a held-out 시군구 go to the
registry board, so a typed address in a held-out district is read, not trained.

The modules:

- `rows.py` — rendering one address in one register, and the eligibility and alignment rules.
- `survey.py` — the two MEASURING passes: neither draws from the RNG, neither writes a row.
- `assemble.py` — the two SELECTING passes, the encoder, the writers and the report. Named for what
  it does rather than `build.py`, because this package re-exports a FUNCTION called `build` and the
  two names cannot both answer to `corpora.build`.
"""

from __future__ import annotations

from .assemble import (
    BOARD_BUCKET_MIN,
    JUSO_ZIP_PARTS,
    PERMIT_DIR_PARTS,
    LabelEncoder,
    build,
    check_no_leak,
    main,
    parse_args,
    select_register_rows,
    select_registry_rows,
    write_label_board,
    write_label_splits,
    write_registry,
)
from .rows import (
    COUNTRY,
    COUNTRY_NAME,
    LABEL_SET_NAME,
    REGISTER_WEIGHTS,
    REGISTRY_SOURCE,
    SHORT_REGIONS,
    SOURCE,
    available_registers,
    choose_register,
    choose_short_region,
    eligible,
    permit_alignment,
    registry_record,
    render_row,
    unit_key,
)
from .survey import PermitSurvey, RegisterSurvey, survey_permits, survey_register

__all__ = [
    "BOARD_BUCKET_MIN",
    "COUNTRY",
    "COUNTRY_NAME",
    "JUSO_ZIP_PARTS",
    "LABEL_SET_NAME",
    "PERMIT_DIR_PARTS",
    "REGISTER_WEIGHTS",
    "REGISTRY_SOURCE",
    "SHORT_REGIONS",
    "SOURCE",
    "LabelEncoder",
    "PermitSurvey",
    "RegisterSurvey",
    "available_registers",
    "build",
    "check_no_leak",
    "choose_register",
    "choose_short_region",
    "eligible",
    "main",
    "parse_args",
    "permit_alignment",
    "registry_record",
    "render_row",
    "select_register_rows",
    "select_registry_rows",
    "survey_permits",
    "survey_register",
    "unit_key",
    "write_label_board",
    "write_label_splits",
    "write_registry",
]
