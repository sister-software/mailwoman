"""Build JP training rows from Overture and KEN_ALL.

The corpus emits stage3-jp admin tags, both compact and designator number registers, and native and
Arabic chōme forms. Spans are recorded while each surface is rendered and revalidated by the training
consumer. Variant folding, name-field hyphen folding, feature channels, and unsourced building names
remain outside this builder.
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
