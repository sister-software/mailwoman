"""The GB house-venue tuple reader takes the `gb-os-open` adapter's rows and refuses Price Paid Data input (#2635)."""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from mailwoman_train.countries.gb import tuples as gb_tuples

#: The header `packages/corpus/lib/tools/fetch/ppd.ts` wrote over the Price Paid Data extract before it was removed.
PPD_TUPLES_HEADER = "NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE"


def os_open_row(postcode: str, street: str = "Wellington Street", **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "raw": f"56 {street}, Leeds {postcode}",
        "components": {"house_number": "56", "street": street, "locality": "Leeds", "postcode": postcode},
        "country": "GB",
        "locale": "en-GB",
        "source": gb_tuples.SOURCE,
        "source_id": f"gb-os-open-{postcode.replace(' ', '').lower()}",
        "license": gb_tuples.LICENSE,
    }
    row.update(overrides)
    return row


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> Path:
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    return path


def test_refuses_the_price_paid_data_tuples_csv(tmp_path: Path) -> None:
    ppd_dir = tmp_path / "ppd" / "2026-07-22"
    ppd_dir.mkdir(parents=True)
    csv_path = ppd_dir / "gb-tuples.csv"
    csv_path.write_text(f"{PPD_TUPLES_HEADER}\n9,High Street,,Leeds,West Yorkshire,LS1 1BA\n", encoding="utf-8")

    with pytest.raises(gb_tuples.RefusedGBTupleSource, match="Price Paid Data"):
        list(gb_tuples.iter_tuples(10, random.Random(0), csv_path))


def test_refuses_a_jsonl_row_from_another_source(tmp_path: Path) -> None:
    """A row the retired `rendered-gb` recipe wrote carries its own source and an OpenAddresses label rather than OGL."""
    rows = [
        os_open_row("LS1 1BA"),
        os_open_row(
            "LS2 7HZ",
            source="synth-gb",
            license="OpenAddresses GB tuples, rendered native-order — see ingest SOURCES",
        ),
    ]
    path = write_jsonl(tmp_path / "canonical.jsonl", rows)

    with pytest.raises(gb_tuples.RefusedGBTupleSource, match="synth-gb"):
        list(gb_tuples.iter_tuples(10, random.Random(0), path))


def test_refuses_an_adapter_row_without_the_ogl_license(tmp_path: Path) -> None:
    path = write_jsonl(tmp_path / "canonical.jsonl", [os_open_row("LS1 1BA", license="")])

    with pytest.raises(gb_tuples.RefusedGBTupleSource, match="OGL-UK-3.0"):
        list(gb_tuples.iter_tuples(10, random.Random(0), path))


def test_a_missing_file_raises_rather_than_yielding_nothing(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        list(gb_tuples.iter_tuples(10, random.Random(0), tmp_path / "canonical.jsonl"))


def test_reads_adapter_rows_into_tuples_stamped_with_their_source(tmp_path: Path) -> None:
    rows = [os_open_row("LS1 1BA"), os_open_row("LS2 7HZ", street="Park Lane")]
    path = write_jsonl(tmp_path / "canonical.jsonl", rows)

    tuples = sorted(gb_tuples.iter_tuples(10, random.Random(0), path), key=lambda t: t["postcode"])

    assert [(t["street"], t["postcode"]) for t in tuples] == [
        ("Wellington Street", "LS1 1BA"),
        ("Park Lane", "LS2 7HZ"),
    ]
    assert {t["source"] for t in tuples} == {gb_tuples.SOURCE}
    assert {t["country"] for t in tuples} == {"GB"}
    assert {t["region"] for t in tuples} == {""}
