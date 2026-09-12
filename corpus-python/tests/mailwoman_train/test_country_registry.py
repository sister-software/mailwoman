"""A country is found through the registry, not by importing its module by name.

A caller that wants a country's label set or board floor asks the registry for the country, rather
than importing the module whose name it has to know. `protocols.CountryModule` is what makes one
line in `COUNTRY_MODULES` enough: it fixes the four names every country answers to.
"""

from __future__ import annotations

import pytest

from mailwoman_train import protocols
from mailwoman_train.countries import COUNTRY_MODULES, country_module


def test_the_three_built_countries_are_registered() -> None:
    assert set(COUNTRY_MODULES) == {"jp", "kr", "tw"}


def test_every_registered_country_satisfies_the_protocol() -> None:
    for code, module in COUNTRY_MODULES.items():
        assert module.COUNTRY_CODE == code, f"{code} disagrees with its own key"
        assert isinstance(module, protocols.CountryModule), code


def test_each_country_names_the_label_set_its_rows_are_tagged_against() -> None:
    """Japan's head is its own; Korea and Taiwan share the CJK head. A country that silently
    inherited the wrong one would train against labels its rows never carry."""
    assert country_module("jp").LABEL_SET_NAME == "stage3-jp"
    assert country_module("kr").LABEL_SET_NAME == "stage3-cjk"
    assert country_module("tw").LABEL_SET_NAME == "stage3-cjk"


def test_the_board_floor_is_per_country() -> None:
    """The municipality-population floor above which a row is held out for the board.

    Japan's is higher than Korea's and Taiwan's because its municipality sizes are distributed
    differently; a single shared constant would move two countries' boards to fix one.
    """
    assert country_module("jp").BOARD_BUCKET_MIN == 97
    assert country_module("kr").BOARD_BUCKET_MIN == 90
    assert country_module("tw").BOARD_BUCKET_MIN == 90


def test_an_unknown_code_names_the_known_ones() -> None:
    with pytest.raises(KeyError) as caught:
        country_module("zz")
    assert "jp" in str(caught.value)


def test_the_lookup_is_case_insensitive() -> None:
    """Callers hold an alpha-2 code from a config or a filename, and those are not all lower case."""
    assert country_module("JP") is country_module("jp")
