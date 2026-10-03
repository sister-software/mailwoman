"""Exposure measurement: unary predicates, pair predicates, and the report's null-versus-zero rule."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from mailwoman_train.exposure.phenomena import (
    ARITY,
    PHENOMENON_IDS,
    LocateError,
    Row,
    Span,
    pair_phenomena,
    reordered_pairs,
    row_phenomena,
    spans_from_components,
)
from mailwoman_train.exposure.report import (
    STAGES,
    StageCounter,
    build_report,
    count_canonical_jsonl,
    numeric_shape_pairs,
)
from tests.paths import REPO_ROOT


def canonical(raw: str, country: str, **components: str) -> Row:
    return Row(raw, country, spans_from_components(raw, components))


def test_ids_mirror_the_typescript_claim_ids() -> None:
    source = (REPO_ROOT / "packages/codex/lib/address/convention-claims.ts").read_text(encoding="utf-8")
    block = source.split("export const ConventionClaimID = {", 1)[1].split("} as const", 1)[0]
    assert tuple(re.findall(r':\s*"([a-z-]+)"', block)) == PHENOMENON_IDS
    arity = source.split("export const CLAIM_ARITY", 1)[1].split("}", 1)[0]
    relational = sorted(p for p, a in ARITY.items() if a == "relational")
    assert arity.count("ClaimArity.Relational") == len(relational) == 1


def test_streetless_premise_requires_a_number_and_a_place_and_no_street() -> None:
    assert (
        row_phenomena(
            canonical("12, Ивановка, Тула", "RU", house_number="12", dependent_locality="Ивановка", locality="Тула")
        )["streetless-premise-identity"]
        == "streetless"
    )
    # A row holding only a locality describes a locality, so it exercises no premise phenomenon.
    assert "streetless-premise-identity" not in row_phenomena(canonical("Тула", "RU", locality="Тула"))
    assert "streetless-premise-identity" not in row_phenomena(
        canonical("улица Ленина, 12, Тула", "RU", street="улица Ленина", house_number="12", locality="Тула")
    )


def test_order_predicates_count_both_orders() -> None:
    ru = canonical(
        "улица Ленина, 12, Тула, 300000",
        "RU",
        street="улица Ленина",
        house_number="12",
        locality="Тула",
        postcode="300000",
    )
    found = row_phenomena(ru)
    assert found["house-number-precedes-street"] == "after"
    assert found["postcode-precedes-locality"] == "after"
    assert found["fixed-width-numeric-postcode"] == "6-digit"

    cn = canonical(
        "湖南省长沙市人民路12号", "CN", region="湖南省", locality="长沙市", street="人民路", house_number="12"
    )
    assert row_phenomena(cn)["largest-unit-first"] == "region-first"


def test_subdivision_and_planning_terms_report_what_matched() -> None:
    row = canonical(
        "Flat 4, 12 Main Road, Sector 12, Gurugram",
        "IN",
        unit="Flat 4",
        house_number="12",
        street="Main Road",
        dependent_locality="Sector 12",
        locality="Gurugram",
    )
    found = row_phenomena(row)
    assert found["premise-subdivision-present"] == "unit"
    assert found["planning-word-names-locality"] == "sector"
    # `12 Sector Road` is a street: the planning word inside a street span is not counted.
    road = canonical("12 Sector Road, Gurugram", "IN", house_number="12", street="Sector Road", locality="Gurugram")
    assert "planning-word-names-locality" not in row_phenomena(road)


def test_a_component_absent_from_raw_raises_rather_than_measuring_fewer_components() -> None:
    with pytest.raises(LocateError):
        spans_from_components("12 Main Road", {"house_number": "12", "locality": "Delhi"})


def test_pairs_compare_pairwise_order_and_numeric_context() -> None:
    native = Row(
        "湖南省长沙市人民路12号",
        "CN",
        (Span("region", 0, 3), Span("locality", 3, 6), Span("street", 6, 9), Span("house_number", 9, 11)),
    )
    romanized = canonical(
        "12 Renmin Road, Changsha, Hunan",
        "CN",
        house_number="12",
        street="Renmin Road",
        locality="Changsha",
        region="Hunan",
    )
    assert pair_phenomena(native, romanized)["ordering-reverses-with-script"] == "reordered"
    assert reordered_pairs(["street", "house_number", "locality"], ["house_number", "street", "locality"]) == [
        ("street", "house_number")
    ]

    india = canonical("Lucknow 226001", "IN", locality="Lucknow", postcode="226001")
    russia = canonical("Тула, 300000", "RU", locality="Тула", postcode="300000")
    assert pair_phenomena(india, russia)["numeric-shape-across-contexts"] == "6-digit:IN/RU"


def test_numeric_shape_pairs_multiply_row_counts_per_width() -> None:
    counter = StageCounter("canonical_rows")
    for country, raw, postcode in [
        ("IN", "Lucknow 226001", "226001"),
        ("IN", "Delhi 110004", "110004"),
        ("RU", "Тула 300000", "300000"),
    ]:
        counter.add(canonical(raw, country, postcode=postcode))
    assert numeric_shape_pairs(counter) == {"6-digit:IN/RU": 2}


def test_report_writes_null_for_an_unmeasured_stage_and_zero_for_a_measured_empty_one(tmp_path: Path) -> None:
    path = tmp_path / "canonical.jsonl"
    rows = [
        {
            "raw": "12, Ивановка, Тула",
            "country": "RU",
            "components": {"house_number": "12", "dependent_locality": "Ивановка", "locality": "Тула"},
        },
        {"raw": "Тула", "country": "RU", "components": {"locality": "Калуга"}},
    ]
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    counter = count_canonical_jsonl(path)
    report = build_report([counter, StageCounter("eligible_training_rows")])
    ru = report["jurisdictions"]["RU"]
    assert set(ru["stages"]) == set(STAGES)
    assert ru["stages"]["canonical_rows"] == {"total": 2, "unreadable": 1}
    assert ru["stages"]["eligible_training_rows"] == {"total": 0, "unreadable": 0}
    assert ru["stages"]["replayed_draws"] is None
    assert ru["phenomena"]["streetless-premise-identity"]["canonical_rows"] == {"streetless": 1}
    assert ru["phenomena"]["streetless-premise-identity"]["eligible_training_rows"] == {}
    assert ru["phenomena"]["streetless-premise-identity"]["replayed_draws"] is None
    assert ru["phenomena"]["ordering-reverses-with-script"]["canonical_rows"] is None
