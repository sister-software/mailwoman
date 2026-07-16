"""The Norway problem — regression tests.

YAML 1.1 resolves the bare token ``NO`` to the boolean ``false``. Every config in this repo wrote

    country_weights:
      NO: 1.0

which produced ``{False: 1.0}``. ``DataConfig.country_weights`` is annotated ``dict[str, float]``
and Python enforces nothing, so the loader's

    weight = country_weights.get(country)   # .get("NO") -> None
    if weight is None or weight <= 0: continue

dropped every Norwegian row. Silently, in 44 configs, from v1.9.0-multilocale through the shipped
v264 (6.3.0) and v310 (6.4.0). Measured cost at the time of the fix: 25,126 Norwegian rows present
in the corpus and reaching the model zero times — 12,000 of them from ``synth-no-street-led``, a
Norwegian phenomenon shard carrying source weight 12.0, the maximum targeted-fix tier. A shard built
to fix a Norwegian defect had never contributed a single row.

``NO`` is the only ISO-3166-1 alpha-2 code that collides with a YAML 1.1 boolean, which is exactly
why it hid: one country, no pattern, and the config text reads correctly.

These tests pin BOTH halves — the guard that rejects the retyped key, and the shipped configs that
must stay quoted. A config-only fix would rot the moment someone adds a country.
"""

from pathlib import Path

import pytest
import yaml

from mailwoman_train.config import DataConfig

CONFIG_DIR = Path(__file__).resolve().parents[2] / "src" / "mailwoman_train" / "configs"


def test_yaml_really_does_retype_bare_no():
    """The premise. If this ever fails, PyYAML changed and the guard's rationale needs a re-read."""
    parsed = yaml.safe_load("country_weights:\n  NO: 1.0\n")

    assert list(parsed["country_weights"]) == [False], "bare NO no longer parses as a boolean"
    assert parsed["country_weights"].get("NO") is None, "the string lookup must miss — that is the bug"


def test_quoted_no_survives():
    parsed = yaml.safe_load('country_weights:\n  "NO": 1.0\n')

    assert parsed["country_weights"]["NO"] == 1.0


def test_dataconfig_rejects_a_retyped_country_key():
    """Raise, don't coerce. A config saying `false` does not MEAN Norway — it means YAML changed the
    author's meaning, and repairing it silently would hide the same class of bug in the next field
    that grows a bare-token key."""
    with pytest.raises(ValueError, match="Norway problem"):
        DataConfig(country_weights={False: 1.0})


def test_dataconfig_accepts_a_quoted_country_key():
    cfg = DataConfig(country_weights={"NO": 1.0, "US": 1.0})

    assert cfg.country_weights["NO"] == 1.0


@pytest.mark.parametrize("config_path", sorted(CONFIG_DIR.glob("*.yaml")), ids=lambda p: p.name)
def test_every_shipped_config_has_string_country_keys(config_path):
    """The 44-config sweep, pinned. Parsed, not grepped — the text always looked right."""
    cfg = yaml.safe_load(config_path.read_text())
    weights = ((cfg or {}).get("data") or {}).get("country_weights") or {}
    offenders = [k for k in weights if not isinstance(k, str)]

    assert not offenders, (
        f"{config_path.name} has non-string country key(s) {offenders} — "
        'an unquoted `NO:` parses as false. Quote it: `"NO": 1.0`.'
    )
