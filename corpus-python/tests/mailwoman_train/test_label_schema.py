"""`labels.py`, `semantic_tags.py`, `address_systems.py` and `features/conventions.py` match the label schema.

`@mailwoman/neural` writes the schema.

The TypeScript constants own the label vocabulary and the semantic tag registry, and the schema references the
address-system registry's ids. Until the trainer moves to Rust, the Python modules stay as readers of the same
vocabulary, and this test fails when they drift.
"""

from __future__ import annotations

import json

from mailwoman_train import address_systems, labels, semantic_tags
from tests import paths

SCHEMA = json.loads((paths.REPO_ROOT / "packages" / "neural" / "data" / "label-schema.v1.json").read_text("utf-8"))


def test_every_label_set_matches_the_schema() -> None:
    assert set(SCHEMA["label_sets"]) == set(labels._LABEL_SETS)
    for name, (tags, bio_labels) in labels._LABEL_SETS.items():
        assert list(tags) == SCHEMA["label_sets"][name]["tags"], name
        assert list(bio_labels) == SCHEMA["label_sets"][name]["bio_labels"], name


def test_the_defaults_and_the_locale_order_match_the_schema() -> None:
    assert SCHEMA["schema_version"] == 1
    assert labels.resolve_label_set().name == SCHEMA["default_label_set"]
    assert labels.IGNORE_INDEX == SCHEMA["ignore_index"]
    assert list(labels.LOCALE_COUNTRIES) == SCHEMA["locale_countries"]


def test_the_semantic_tag_registry_matches_the_schema() -> None:
    registry = SCHEMA["semantic_tags"]
    assert semantic_tags.SEMANTIC_TAG_REGISTRY_VERSION == registry["registry_version"]
    assert list(semantic_tags.SEMANTIC_TAGS) == registry["tags"]
    assert semantic_tags.REFINES == registry["refines"]
    assert sorted(semantic_tags.UNREFINED) == registry["unrefined"]
    for name in labels._LABEL_SETS:
        contract = semantic_tags.label_set_contract(name)
        assert contract["head_mapping"] == registry["head_mappings"][name], name


def test_the_conventions_mirror_matches_the_schema() -> None:
    from mailwoman_train.features.conventions import CONVENTIONS_FORBIDDEN_TAGS

    mirror = {country: list(tags) for country, tags in CONVENTIONS_FORBIDDEN_TAGS.items()}
    assert mirror == SCHEMA["conventions_forbidden_tags"]


def test_the_address_systems_the_schema_references_are_the_registry_python_reads() -> None:
    referenced = SCHEMA["address_systems"]
    assert referenced["registry"] == "corpus-python/src/mailwoman_train/address_systems.json"
    assert address_systems.num_address_systems() == len(referenced["systems"])
    table = address_systems.address_system_table()
    assert [{"id": row["id"], "key": row["key"]} for row in table] == referenced["systems"]
