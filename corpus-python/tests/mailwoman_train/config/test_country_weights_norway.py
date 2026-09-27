import pytest
import yaml

from mailwoman_train.config import DataConfig
from tests import paths

CONFIG_DIR = paths.CONFIGS


def test_yaml_really_does_retype_bare_no():
    parsed = yaml.safe_load("country_weights:\n  NO: 1.0\n")

    assert list(parsed["country_weights"]) == [False], "bare NO no longer parses as a boolean"
    assert parsed["country_weights"].get("NO") is None, "the string lookup must miss — that is the bug"


def test_quoted_no_survives():
    parsed = yaml.safe_load('country_weights:\n  "NO": 1.0\n')

    assert parsed["country_weights"]["NO"] == 1.0


def test_dataconfig_rejects_a_retyped_country_key():
    with pytest.raises(ValueError, match="Norway problem"):
        DataConfig(country_weights={False: 1.0})


def test_dataconfig_accepts_a_quoted_country_key():
    cfg = DataConfig(country_weights={"NO": 1.0, "US": 1.0})

    assert cfg.country_weights["NO"] == 1.0


@pytest.mark.parametrize("config_path", sorted(CONFIG_DIR.glob("*.yaml")), ids=lambda p: p.name)
def test_every_shipped_config_has_string_country_keys(config_path):
    cfg = yaml.safe_load(config_path.read_text())
    weights = ((cfg or {}).get("data") or {}).get("country_weights") or {}
    offenders = [k for k in weights if not isinstance(k, str)]

    assert not offenders, (
        f"{config_path.name} has non-string country key(s) {offenders} — "
        'an unquoted `NO:` parses as false. Quote it: `"NO": 1.0`.'
    )
