"""The deterministic halves of the DeepSeek generator: batch ids, prompts, and response parsing.

A batch id is what the checkpoint file stores, so it decides whether a restart SKIPS a batch or
pays for it again. It is derived from the seeds and the script slug, and nothing else in the suite
reads it — a refactor that changes the derivation invalidates every checkpoint on disk, and the
only symptom is a larger bill.

The response parser and the component validator are the other half worth pinning: both accept
model output, and both are written to be forgiving, which is exactly where a rewrite quietly starts
accepting rows it should reject.

Nothing here calls the API. `deepseek_call` is the one function that does, and it is not exercised.
"""

from __future__ import annotations

from typing import Any

import pytest

from mailwoman_train.corpora.deepseek import (
    KRYPTONITE_CATEGORIES,
    TRANSLIT_SCRIPTS,
    build_kryptonite_user_prompt,
    build_translit_user_prompt,
    deterministic_id,
    parse_jsonl_response,
    validate_components,
)

SEEDS: list[dict[str, Any]] = [
    {
        "raw": "350 5th Ave, New York, NY 10118",
        "components": {"house_number": "350", "street": "5th Ave", "locality": "New York", "region": "NY"},
        "source_id": "seed-us-0001",
        "locale": "en-US",
    },
    {
        "raw": "5 Avenue Anatole France, 75007 Paris",
        "components": {"house_number": "5", "street": "Avenue Anatole France", "locality": "Paris"},
        "source_id": "seed-fr-0002",
        "locale": "fr-FR",
    },
]


def test_a_batch_id_is_stable_for_the_same_seeds_and_script() -> None:
    """The checkpoint's whole contract: same inputs, same id, so a restart skips what it paid for."""
    payload = '["seed-us-0001", "seed-fr-0002"]|cyrl'
    assert deterministic_id("translit-cyrl", payload) == deterministic_id("translit-cyrl", payload)
    # The literal, not a re-derivation: comparing against a second call to the same function would
    # pass however the derivation changed, and it is the derivation that every checkpoint depends on.
    assert deterministic_id("translit-cyrl", payload) == "translit-cyrl-f9f2cedf899da917"


def test_a_batch_id_changes_with_the_script_and_with_the_seeds() -> None:
    """Two batches that differ must not collide, or one of them is never generated."""
    base = deterministic_id("translit-cyrl", '["seed-us-0001"]|cyrl')
    assert base != deterministic_id("translit-kana", '["seed-us-0001"]|kana')
    assert base != deterministic_id("translit-cyrl", '["seed-fr-0002"]|cyrl')


def test_the_transliteration_prompt_carries_every_seed_and_its_components() -> None:
    """A seed missing from the prompt is a row the model is never asked for and nobody counts."""
    prompt = build_translit_user_prompt("Russian Cyrillic", SEEDS)
    assert prompt.splitlines()[0] == "Script: Russian Cyrillic"
    for index, seed in enumerate(SEEDS):
        assert f'{index}: raw="{seed["raw"]}"' in prompt
        for tag, value in seed["components"].items():
            assert f'{tag}="{value}"' in prompt


def test_the_kryptonite_prompt_carries_the_category_and_its_examples() -> None:
    category = KRYPTONITE_CATEGORIES[0]
    prompt = build_kryptonite_user_prompt(category, 12)
    assert str(category["category"]) in prompt
    assert str(category["description"]) in prompt
    for example in category["examples"]:
        assert f"- {example}" in prompt
    assert "12" in prompt


def test_every_script_and_category_is_well_formed() -> None:
    """The two tables are hand-maintained; a row missing a field fails at request time, mid-spend."""
    for label, locale, country, slug in TRANSLIT_SCRIPTS:
        assert label and locale and country and slug
        assert slug.islower() and " " not in slug
    slugs = [slug for *_, slug in TRANSLIT_SCRIPTS]
    assert len(slugs) == len(set(slugs)), "two scripts share a slug, so their batch ids collide"

    for category in KRYPTONITE_CATEGORIES:
        assert {"category", "description", "examples", "weight"} <= set(category)
        assert category["examples"], f"{category['category']} has no examples to steer the model"
        assert float(category["weight"]) > 0
    names = [str(c["category"]) for c in KRYPTONITE_CATEGORIES]
    assert len(names) == len(set(names)), "two categories share a name, so their batch ids collide"


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ('{"i": 0, "raw": "a"}\n{"i": 1, "raw": "b"}', 2),
        ('```jsonl\n{"i": 0, "raw": "a"}\n```', 1),
        ("not json at all\n{bad json}\n", 0),
        ("", 0),
        ('  {"i": 0, "raw": "a"}  \n\n', 1),
    ],
)
def test_the_response_parser_keeps_only_the_object_lines(content: str, expected: int) -> None:
    """Model output arrives fenced, prefaced and occasionally truncated; only whole objects count."""
    assert len(parse_jsonl_response(content)) == expected


@pytest.mark.parametrize(
    ("raw", "components", "reason"),
    [
        ("350 5th Ave", {"house_number": "350", "street": "5th Ave"}, None),
        ("350 5th Ave", {}, "no-components"),
        ("350 5th Ave", {"street": ""}, "empty-component:street"),
        ("350 5th Ave", {"street": "6th Ave"}, "not-in-raw:street"),
        ("x" * 251, {"street": "x"}, "raw-length"),
    ],
)
def test_component_validation_names_why_a_row_is_rejected(
    raw: str, components: dict[str, str], reason: str | None
) -> None:
    """The substring invariant is the whole guarantee on a generated row: every surface is IN the raw."""
    ok, got = validate_components(raw, components)
    assert (ok, got) == (reason is None, reason)
