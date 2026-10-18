"""Great Britain: house-venue tuples from the `gb-os-open` adapter's OS OpenData rows.

The adapter joins each Code-Point Open postcode to its nearest named OS Open Roads link and takes the
street and locality from OS Open Names. All three products are under the Open Government Licence v3.0.
The house number is one the adapter drew, because no open GB product publishes one.

The tuples used to come from HM Land Registry Price Paid Data. Its address fields are Royal Mail and
Ordnance Survey data licensed for personal or non-commercial use only (#2635), so this reader refuses
any row whose source id and license are not the adapter's, and refuses any input that is not JSONL.
"""

from __future__ import annotations

import json
import random
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ...paths import data_root_path

#: The rows `mailwoman corpus run gb-os-open --out $MAILWOMAN_DATA_ROOT/corpus/staging/gb-os-open` writes.
#: `gbOSOpenCanonicalRowsPath` in `packages/corpus/lib/gb/adapters/os-open/adapter.ts` spells the same parts.
CANONICAL_ROWS_PARTS = ("corpus", "staging", "gb-os-open", "gb-os-open", "canonical.jsonl")

#: The `source` and `license` every row must carry: the adapter's id and its OGL v3.0 SPDX id.
SOURCE = "gb-os-open"
LICENSE = "OGL-UK-3.0"


class RefusedGBTupleSource(ValueError):
    """The input is not the `gb-os-open` adapter's rows, so it may carry Price Paid Data address fields."""


def iter_tuples(count: int, rng: random.Random, path: Path | None = None) -> Iterator[dict[str, Any]]:
    """Reservoir-sample the adapter's rows in one streaming pass.

    The GB layout prints no region, and the adapter writes none, so `region` is empty.

    Raises:
        RefusedGBTupleSource: when `path` is not a JSONL file, or a row's `source` or `license` is not the
            adapter's. A missing file raises `FileNotFoundError` rather than yielding an empty sample.
    """
    rows_path = path or data_root_path(*CANONICAL_ROWS_PARTS)
    if rows_path.suffix != ".jsonl":
        raise RefusedGBTupleSource(
            f"{rows_path} is not a canonical.jsonl. GB tuples come only from the {SOURCE} adapter's rows; "
            "the Price Paid Data CSV is refused (#2635)."
        )
    reservoir: list[dict[str, Any]] = []
    seen = 0
    with rows_path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("source") != SOURCE or row.get("license") != LICENSE:
                raise RefusedGBTupleSource(
                    f"{rows_path}:{line_number} has source {row.get('source')!r} and license "
                    f"{row.get('license')!r}; GB tuples accept {SOURCE} rows under {LICENSE} only."
                )
            components = row.get("components") or {}
            number = (components.get("house_number") or "").strip()
            street = (components.get("street") or "").strip()
            locality = (components.get("locality") or "").strip()
            postcode = (components.get("postcode") or "").strip()
            if not (number and street and locality and postcode):
                continue
            tup = {
                "locality": locality,
                "region": "",
                "postcode": postcode,
                "country": "GB",
                "street": street,
                "houseNumber": number,
                "source": SOURCE,
                "sourceID": row.get("source_id"),
            }
            seen += 1
            if len(reservoir) < count:
                reservoir.append(tup)
            else:
                index = rng.randrange(seen)
                if index < count:
                    reservoir[index] = tup
    rng.shuffle(reservoir)
    yield from reservoir
