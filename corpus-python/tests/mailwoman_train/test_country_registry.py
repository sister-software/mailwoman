"""A country is found through the registry, not by importing its module by name.

A caller that wants a country's label set or board floor asks the registry for the country, rather
than importing the module whose name it has to know. `protocols.CountryModule` is what makes one
line in `COUNTRY_MODULES` enough: it fixes the four names every country answers to.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from mailwoman_train import protocols
from mailwoman_train.countries import COUNTRY_MODULES, REGIONS, SOURCE_ONLY, country_module

COUNTRIES_ROOT = Path(__file__).resolve().parents[2] / "src" / "mailwoman_train" / "countries"

#: Alpha-2 codes as they appear in a module's own identifiers and string literals. A country
#: directory naming another country's code is reaching across the boundary this layout draws.
ALPHA2 = frozenset(COUNTRY_MODULES) | SOURCE_ONLY


def test_the_three_built_countries_are_registered() -> None:
    assert set(COUNTRY_MODULES) == {"jp", "kr", "tw"}


def test_every_country_directory_is_declared_as_one_kind_or_the_other() -> None:
    """A directory in neither group is a country nobody can find and nothing checks.

    Without this the registry and the filesystem drift apart silently: a new country lands as a
    directory, is never registered, and a caller reaching for it through `country_module` is told
    it does not exist while its code sits right there.
    """
    on_disk = {path.name for path in COUNTRIES_ROOT.iterdir() if path.is_dir() and not path.name.startswith("__")}
    declared = set(COUNTRY_MODULES) | SOURCE_ONLY | REGIONS
    assert on_disk == declared, f"undeclared: {sorted(on_disk - declared)}; missing: {sorted(declared - on_disk)}"


def test_a_country_directory_names_no_other_country() -> None:
    """Two countries never share a module.

    A French title-caser, the US per-state situs layout and the GB Price Paid derivation lived in
    one file, so a change to one country's source edited the file the other two were read from.
    This walks each country module for another country's alpha-2 code in a string literal or a
    dotted import, which is what reaching across the boundary looks like.
    """
    offenders: list[str] = []
    for directory in sorted(COUNTRIES_ROOT.iterdir()):
        if not directory.is_dir() or directory.name in REGIONS or directory.name.startswith("__"):
            continue
        own = directory.name
        foreign = ALPHA2 - {own}
        for path in sorted(directory.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module:
                    parts = node.module.split(".")
                    named = {part for part in parts if part in foreign}
                    if "countries" in parts and named:
                        offenders.append(f"{path.relative_to(COUNTRIES_ROOT)} imports from {sorted(named)}")
                elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                    if node.value.upper() in {code.upper() for code in foreign}:
                        offenders.append(f"{path.relative_to(COUNTRIES_ROOT)}:{node.lineno} names {node.value!r}")
    assert offenders == [], "a country module reaches into another country:\n" + "\n".join(offenders)


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
