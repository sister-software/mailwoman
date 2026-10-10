"""The shared semantic tag registry: one global id per concept, whichever family's head holds it."""

from __future__ import annotations

import re

import pytest

from mailwoman_train.labels import _LABEL_SETS, STAGE4_FINE_TAGS, resolve_label_set
from mailwoman_train.semantic_tags import (
    REFINES,
    SEMANTIC_TAG_ID,
    SEMANTIC_TAGS,
    UNREFINED,
    ProjectionLedger,
    head_mapping,
    label_set_contract,
    project_tag,
)
from tests.paths import REPO_ROOT


def test_every_label_set_maps_onto_registered_ids() -> None:
    for name in _LABEL_SETS:
        mapping = head_mapping(resolve_label_set(name))
        assert len(mapping) == len(set(mapping)), name


def test_registry_ids_are_unique_and_every_tag_is_refined_or_declared_unrefined() -> None:
    assert len(SEMANTIC_TAGS) == len(SEMANTIC_TAG_ID)
    fine = set(SEMANTIC_TAGS) - set(resolve_label_set("stage3").tags)
    assert fine == set(REFINES) | UNREFINED
    assert not set(REFINES) & UNREFINED


def test_one_concept_keeps_its_global_id_when_its_head_index_differs() -> None:
    cn, cjk = resolve_label_set("stage3-cn"), resolve_label_set("stage3-cjk")
    assert cn.tags.index("locality_unit") != cjk.tags.index("locality_unit")
    assert (
        head_mapping(cn)[cn.tags.index("locality_unit")]
        == head_mapping(cjk)[cjk.tags.index("locality_unit")]
        == SEMANTIC_TAG_ID["locality_unit"]
    )


def test_registry_covers_the_js_component_union() -> None:
    source = (REPO_ROOT / "packages/codex/lib/component.ts").read_text(encoding="utf-8")
    block = source.split("export const COMPONENT_TAGS = [", 1)[1].split("] as const", 1)[0]
    js_tags = set(re.findall(r'"([a-z_]+)"', block))
    assert js_tags <= set(SEMANTIC_TAGS)
    # The STAGE4 secondary-address tags are defined in Python and absent from the JS union. They stay
    # inactive until a stage4 family ships. That commit must extend the JS union.
    assert set(SEMANTIC_TAGS) - js_tags == set(STAGE4_FINE_TAGS)


def test_native_and_romanized_japanese_carry_the_same_semantic_labels() -> None:
    # 東京都千代田区丸の内1丁目1番1号 and `1-1-1 Marunouchi, Chiyoda, Tokyo` name the same premise.
    native = ["prefecture", "municipality", "district", "block", "sub_block", "building_number"]
    romanized = ["house_number", "district", "municipality", "prefecture"]
    assert {SEMANTIC_TAG_ID[t] for t in romanized} <= {SEMANTIC_TAG_ID[t] for t in native} | {
        SEMANTIC_TAG_ID["house_number"]
    }

    latin = resolve_label_set("stage3")
    cjk = resolve_label_set("stage3-cjk")
    assert [project_tag(t, latin) for t in romanized] == ["house_number", "dependent_locality", "locality", "region"]
    assert [project_tag(t, cjk) for t in romanized] == romanized


def test_the_long_form_number_projects_to_one_house_number_span() -> None:
    ledger = ProjectionLedger(resolve_label_set("stage3"))
    labels = [
        "B-municipality",
        "I-municipality",
        "B-block",
        "I-block",
        "B-sub_block",
        "B-building_number",
        "I-building_number",
    ]
    assert ledger.project_sequence(labels) == [
        "B-locality",
        "I-locality",
        "B-house_number",
        "I-house_number",
        "I-house_number",
        "I-house_number",
        "I-house_number",
    ]
    # Two adjacent spans of a tag the head holds stay two spans.
    assert ledger.project_sequence(["B-street", "B-street"]) == ["B-street", "B-street"]


def test_a_concept_the_family_cannot_emit_is_counted_rather_than_silent() -> None:
    ledger = ProjectionLedger(resolve_label_set("stage3"))
    assert ledger.project_sequence(["B-locality_unit", "I-locality_unit", "B-region"]) == ["O", "O", "B-region"]
    report = ledger.report()
    assert report["unrepresentable"] == {"locality_unit": 2}
    assert report["label_set_id"] == "stage3"
    assert report["semantic_tag_registry_version"] == label_set_contract("stage3")["semantic_tag_registry_version"]


@pytest.mark.parametrize("name", sorted(_LABEL_SETS))
def test_contract_head_mapping_follows_head_order(name: str) -> None:
    contract = label_set_contract(name)
    assert [SEMANTIC_TAGS[i] for i in contract["head_mapping"]] == contract["head_tags"]  # type: ignore[union-attr]
