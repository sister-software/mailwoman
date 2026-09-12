"""One seeded Korea build, pinned end to end — both corpora, both boards, and the report.

`build` makes four passes and threads one `random.Random` through the last two: the exact-selection
masks for the register rows, the shuffle, the per-row register and country draws, then a second set
of masks for the registry rows. The passes also feed each other — pass 1's key index is what pass 2
aligns permits against — so a stage that moves changes what the later ones see.

Nothing exercised this path: the real inputs are the 주소DB archive, the permit registry, and
`gdaltransform`. The fixture supplies the first two at the portal's real CP949 shapes. The third is
STUBBED rather than skipped, because `gdaltransform` is a projection this builder does not own —
what the pin is for is the builder's order and its rendering, and a `skipif` on a missing binary
would report a passing suite that ran none of this.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
import pytest

from mailwoman_train.countries.kr import registers
from mailwoman_train.countries.kr.corpora import build

from .kr_fixture import JusoAddress, JusoRegion, write_juso_zip, write_permit_csv

#: Committed beside this file, captured from the code as it stood BEFORE a split. Regenerating it
#: after a change makes the test compare the new code against itself, so regenerate only when the
#: current code is already verified against the existing reference.
#:
#: Regenerate with: uv run python -m tests.mailwoman_train.countries.test_kr_build_parity
REFERENCE = Path(__file__).parent / "kr-build-reference.json"

REFERENCE_README = [
    "Pins one seeded Korea build across a refactor.",
    "Regenerate: uv run python -m tests.mailwoman_train.countries.test_kr_build_parity",
    "Fixture: REGIONS and PERMITS in the test beside this file — a 주소DB archive and permit CSVs",
    "  at the portal's CP949 shapes, sized so a build finishes in a second.",
    "  gdaltransform is stubbed: the projection is not this builder's code, and skipping on a",
    "  missing binary would report a green suite that exercised none of this.",
    "",
    "label: every rendered register row as raw + register + the span triple, in emission order.",
    "board: the held-out 시군구 rows, same form, each carrying its permit-derived centroid.",
    "registry: the aligned permit rows, and the registry board.",
    "report: the build report with the fixture's tmp paths removed.",
]

#: Four pool units and two held-out ones. 종로구 and 해운대구 both hash to bucket 92, over the
#: default board floor of 90; 중구, 성남시분당구 and 제주시 sit at 0, 78 and 45.
REGIONS = [
    JusoRegion(
        region="서울특별시",
        sigungu="중구",
        eupmyeondong="소공동",
        road="세종대로",
        road_code="111104100010",
        serial="01",
        kind="1",
        lot_code="1114010100",
        addresses=[
            JusoAddress(address_id="11140000000001", main="00110", dong="태평로1가", building="서울시청"),
            JusoAddress(address_id="11140000000002", main="00040", dong="정동", lot_main="0005"),
            JusoAddress(address_id="11140000000003", main="00136", sub="0012", dong="남대문로4가"),
        ],
    ),
    JusoRegion(
        region="서울특별시",
        sigungu="종로구",
        eupmyeondong="청운효자동",
        road="자하문로",
        road_code="111104100001",
        serial="02",
        kind="1",
        lot_code="1111010100",
        addresses=[
            JusoAddress(address_id="11110000000001", main="00094", dong="청운동", building="청운빌딩"),
            JusoAddress(address_id="11110000000002", main="00120", dong="효자동", lot_main="0031"),
        ],
    ),
    JusoRegion(
        region="부산광역시",
        sigungu="중구",
        eupmyeondong="남포동",
        road="광복로",
        road_code="261104100001",
        serial="01",
        kind="1",
        lot_code="2611010100",
        addresses=[
            JusoAddress(address_id="26110000000001", main="00055", postcode="48952", dong="창선동1가"),
            JusoAddress(address_id="26110000000002", main="00085", sub="0003", postcode="48952", dong="신창동"),
        ],
    ),
    JusoRegion(
        region="부산광역시",
        sigungu="해운대구",
        eupmyeondong="우동",
        road="해운대해변로",
        road_code="261104100020",
        serial="02",
        kind="1",
        lot_code="2635010300",
        addresses=[JusoAddress(address_id="26350000000001", main="00264", postcode="48099", dong="우동")],
    ),
    JusoRegion(
        region="경기도",
        sigungu="성남시분당구",
        eupmyeondong="정자동",
        road="분당로",
        road_code="411304100001",
        serial="01",
        kind="1",
        lot_code="4113510300",
        addresses=[
            JusoAddress(address_id="41135000000001", main="00050", postcode="13561", dong="정자동"),
            JusoAddress(address_id="41135000000002", main="00072", sub="0001", postcode="13561", dong="수내동"),
        ],
    ),
    JusoRegion(
        region="제주특별자치도",
        sigungu="제주시",
        eupmyeondong="이도일동",
        road="문연로",
        road_code="501104100001",
        serial="01",
        kind="1",
        lot_code="5011010800",
        addresses=[
            JusoAddress(address_id="50110000000001", main="00006", postcode="63122", dong="연동"),
            JusoAddress(address_id="50110000000002", main="00018", postcode="63122", dong="이도이동", building="도청"),
        ],
    ),
]

#: (name, status, road address, lot address, road postcode, lot postcode, x, y). The road forms are
#: written to align against the index above; the last row aligns against neither, which is what puts
#: an unaligned permit on the registry board.
PERMITS: list[tuple[str, str, str, str, str, str, str, str]] = [
    (
        "서울식당",
        "영업/정상",
        "서울특별시 중구 세종대로 110",
        "서울특별시 중구 태평로1가 31",
        "04524",
        "04524",
        "198000",
        "451000",
    ),
    (
        "정동카페",
        "영업/정상",
        "서울특별시 중구 세종대로 40",
        "서울특별시 중구 정동 5",
        "04521",
        "04521",
        "198100",
        "451100",
    ),
    (
        "청운상회",
        "영업/정상",
        "서울특별시 종로구 자하문로 94",
        "서울특별시 종로구 청운동 52-1",
        "03047",
        "03047",
        "197900",
        "452500",
    ),
    (
        "광복분식",
        "영업/정상",
        "부산광역시 중구 광복로 55",
        "부산광역시 중구 창선동1가 5",
        "48952",
        "48952",
        "388000",
        "174000",
    ),
    (
        "해운대횟집",
        "영업/정상",
        "부산광역시 해운대구 해운대해변로 264",
        "부산광역시 해운대구 우동 1394",
        "48099",
        "48099",
        "395000",
        "176000",
    ),
    (
        "분당제과",
        "영업/정상",
        "경기도 성남시분당구 분당로 50",
        "경기도 성남시분당구 정자동 178",
        "13561",
        "13561",
        "207000",
        "433000",
    ),
    (
        "제주국수",
        "영업/정상",
        "제주특별자치도 제주시 문연로 6",
        "제주특별자치도 제주시 연동 312",
        "63122",
        "63122",
        "150000",
        "37000",
    ),
    (
        "폐업식당",
        "폐업",
        "서울특별시 중구 세종대로 110",
        "서울특별시 중구 태평로1가 31",
        "04524",
        "04524",
        "198000",
        "451000",
    ),
    ("미상업소", "영업/정상", "없는도 없는시 없는로 1", "없는도 없는시 없는동 1", "00000", "00000", "", ""),
]


def stub_transform(points: list[tuple[float, float]]) -> list[tuple[float, float] | None]:
    """A deterministic stand-in for `gdaltransform`, mapping the fixture's planar grid into Korea.

    The real transform is EPSG:5174 → WGS84 through a subprocess. What this build does with the
    answer — sum it per unit, divide, write the centroid beside the board row — is the part under
    test, and that is unchanged by which projection produced the numbers.
    """
    out: list[tuple[float, float] | None] = []
    for x, y in points:
        lon = 124.0 + (x % 100_000) / 100_000 * 8.0
        lat = 33.0 + (y % 100_000) / 100_000 * 6.5
        out.append((round(lon, 6), round(lat, 6)))
    return out


def write_fixture(root: Path) -> tuple[Path, Path]:
    """The 주소DB archive and the permit directory, returned as (zip, permit dir)."""
    root.mkdir(parents=True, exist_ok=True)
    archive = root / "202608ALLMTCHG00.zip"
    write_juso_zip(archive, REGIONS)
    permits = root / "localdata-kr"
    permits.mkdir(exist_ok=True)
    write_permit_csv(permits / "일반음식점.csv", PERMITS)
    return archive, permits


def reference_args(archive: Path, permits: Path, out_dir: Path, registry_dir: Path) -> argparse.Namespace:
    return argparse.Namespace(
        juso_zip=str(archive),
        permit_dir=str(permits),
        permit_glob="*.csv",
        out_dir=str(out_dir),
        registry_out_dir=str(registry_dir),
        train_rows=6,
        val_rows=2,
        board_rows=3,
        registry_rows=6,
        registry_board_rows=3,
        registry_val_fraction=0.25,
        rows_per_part=4,
        stats_sample_per_part=8,
        country_fraction=0.4,
        max_field_chars=64,
        max_rows_per_region=None,
        board_bucket_min=90,
        seed=42,
        force=True,
    )


def run_build(root: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """One build against the fixture, with the projection stubbed, returned as the pinned payload."""
    monkeypatch.setattr(registers, "transform_coordinates", stub_transform)
    archive, permits = write_fixture(root)
    out_dir, registry_dir = root / "slice", root / "registry"
    report = build(reference_args(archive, permits, out_dir, registry_dir))

    def rendered(directory: Path) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for split in ("train", "val"):
            for path in sorted((directory / split).glob("*.parquet")):
                table = pq.read_table(path, columns=["raw", "register", "span_starts", "span_ends", "span_tags"])
                out.extend({"split": split, **row} for row in table.to_pylist())
        return out

    def jsonl(path: Path) -> list[dict[str, Any]]:
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    trimmed = {key: value for key, value in report.items() if key not in ("juso_zip", "permit_dir")}
    return {
        "label": rendered(out_dir),
        "board": jsonl(out_dir / "kr-board.jsonl"),
        "registry": rendered(registry_dir),
        "registry_board": jsonl(registry_dir / "kr-registry-board.jsonl"),
        "centroids": json.loads((out_dir / "kr-sigungu-centroids.json").read_text(encoding="utf-8")),
        "report": trimmed,
    }


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    patch = pytest.MonkeyPatch()
    try:
        return run_build(tmp_path_factory.mktemp("kr-build"), patch)
    finally:
        patch.undo()


def test_the_build_is_deterministic_under_a_fixed_seed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Sanity: two builds of the same fixture agree, so a later mismatch means the code moved."""
    assert run_build(tmp_path / "a", monkeypatch) == run_build(tmp_path / "b", monkeypatch)


@pytest.mark.parametrize("section", ["label", "board", "registry", "registry_board", "centroids"])
def test_the_written_corpora_match_the_committed_reference(built: dict[str, Any], section: str) -> None:
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text(encoding="utf-8"))[section]
    assert built[section] == expected, f"{section} moved"


def test_the_report_matches_the_committed_reference(built: dict[str, Any]) -> None:
    """The alignment census, the pools and the vocab sizes — the figures a reader trusts."""
    if not REFERENCE.is_file():
        pytest.skip(f"no reference at {REFERENCE}; generate it before splitting")
    expected = json.loads(REFERENCE.read_text(encoding="utf-8"))["report"]
    assert built["report"] == expected


def test_every_span_covers_the_text_it_claims(built: dict[str, Any]) -> None:
    """Holds for any input, so it says something when it stops holding."""
    for section in ("label", "registry", "board"):
        for row in built[section]:
            raw = row["raw"]
            triple = zip(row["span_starts"], row["span_ends"], row["span_tags"], strict=True)
            for start, end, tag in triple:
                assert 0 <= start < end <= len(raw), f"{section}: {tag} span ({start}, {end}) is outside {raw!r}"
                covered = raw[start:end]
                assert covered == covered.strip(), f"{section}: {tag} covers {covered!r}, which has an edge space"


def test_the_fixture_exercises_both_pools_and_both_boards(built: dict[str, Any]) -> None:
    """A fixture that produced no board rows, or no aligned permit, would pin an empty path."""
    assert built["report"]["board_sigungu"] >= 2, "no held-out 시군구 — the bucket floor missed the fixture"
    assert built["report"]["registry"]["pool"]["aligned"] > 0, "no permit aligned against the key index"
    assert built["report"]["registry"]["pool"]["unaligned"] > 0, "no unaligned permit reached the registry board"
    assert built["centroids"], "no centroid landed, so the board rows carry no coordinate"


def write_reference() -> None:
    """Capture the current build as the reference the tests above compare against.

    Run this only when the current code already passes against the existing reference — otherwise
    the artifact records whatever the code does now, and the tests assert nothing.
    """
    import tempfile

    patch = pytest.MonkeyPatch()
    try:
        with tempfile.TemporaryDirectory() as scratch:
            payload = {"README": REFERENCE_README, **run_build(Path(scratch), patch)}
    finally:
        patch.undo()
    REFERENCE.write_text(json.dumps(payload, ensure_ascii=False, indent="\t", sort_keys=False) + "\n")
    print(f"wrote {REFERENCE}")
    print(f"  {len(payload['label'])} label, {len(payload['board'])} board, {len(payload['registry'])} registry rows")


if __name__ == "__main__":
    write_reference()
