"""`labels.py` matches the label schema `@mailwoman/neural` writes from its TypeScript constants.

The TypeScript constants own the label vocabulary. Until the trainer moves to Rust, the Python constants stay as a
reader of the same vocabulary, and this test fails when the two drift.
"""

from __future__ import annotations

import json

from mailwoman_train import labels
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
