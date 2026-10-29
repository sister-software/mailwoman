"""Every country directory is declared, and no country module reaches into another country."""

from __future__ import annotations

import ast

from mailwoman_train.countries import REGIONS, SOURCE_ONLY
from tests import paths

COUNTRIES_ROOT = paths.SOURCE_ROOT / "countries"

#: Alpha-2 codes as they appear in a module's own identifiers and string literals. A directory
#: naming another country's code reaches across the boundary this layout draws.
ALPHA2 = SOURCE_ONLY


def test_every_country_directory_is_declared() -> None:
    """An undeclared directory has no entry or test, so the declaration and the filesystem would drift apart silently."""
    on_disk = {path.name for path in COUNTRIES_ROOT.iterdir() if path.is_dir() and not path.name.startswith("__")}
    declared = SOURCE_ONLY | REGIONS
    assert on_disk == declared, f"undeclared: {sorted(on_disk - declared)}; missing: {sorted(declared - on_disk)}"


def test_a_country_directory_names_no_other_country() -> None:
    """Two countries never share a module. This walks each country module for another country's alpha-2 code in a string literal or a dotted import."""
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
