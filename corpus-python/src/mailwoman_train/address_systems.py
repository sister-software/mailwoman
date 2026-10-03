"""The address system a row's text follows, as the id the address-system head is trained against.

``address_systems.json`` is generated from @mailwoman/codex's layouts by ``mailwoman dev generate
address-systems``. Each system is one component order. Countries that print the same components in the
same order share a system, so the head learns grammars rather than countries. Ids are append-only, because
a checkpoint's head has one output per id.

A country has a ``local`` system and, where libaddressinput states a separate Latin-script layout, a
``latin`` one. A row written in Latin script reads the ``latin`` system when its country has one. Every
other row reads ``local``. A country with no layout has no system, and its rows carry ``IGNORE_INDEX``.
"""

from __future__ import annotations

import json
import unicodedata
from functools import cache
from importlib import resources
from typing import Final, TypedDict

from .labels import IGNORE_INDEX


class _SystemEntry(TypedDict):
    id: int
    key: str


class _MemberEntry(TypedDict):
    country: str
    script: str
    system: int


class _Registry(TypedDict):
    systems: list[_SystemEntry]
    members: list[_MemberEntry]


@cache
def _registry() -> _Registry:
    text = resources.files("mailwoman_train").joinpath("address_systems.json").read_text(encoding="utf-8")
    registry: _Registry = json.loads(text)
    return registry


@cache
def _members() -> dict[tuple[str, str], int]:
    return {(m["country"], m["script"]): m["system"] for m in _registry()["members"]}


class AddressSystemRow(TypedDict):
    id: int
    key: str
    members: list[str]


def address_system_table() -> list[AddressSystemRow]:
    """Every registered system: its id, its component-order key, and the ``CC/script`` members that follow it."""
    members: dict[int, list[str]] = {}
    for (country, script), system in sorted(_members().items()):
        members.setdefault(system, []).append(f"{country}/{script}")
    return [{"id": s["id"], "key": s["key"], "members": members.get(s["id"], [])} for s in _registry()["systems"]]


def num_address_systems() -> int:
    """The address-system head's output count: every id the registry has assigned."""
    return len(_registry()["systems"])


LOCAL_SCRIPT: Final = "local"
LATIN_SCRIPT: Final = "latin"


def address_system_for_country(country: str | None, *, latin: bool) -> int:
    """The id of ``country``'s system in the chosen script, or ``IGNORE_INDEX`` without one."""
    if not country:
        return IGNORE_INDEX
    code = country.strip().upper()
    members = _members()
    if latin and (code, LATIN_SCRIPT) in members:
        return members[(code, LATIN_SCRIPT)]
    return members.get((code, LOCAL_SCRIPT), IGNORE_INDEX)


def is_latin_text(text: str) -> bool:
    """Whether ``text`` holds a letter and every letter it holds is Latin script.

    @mailwoman/codex's ``isLatinScriptText`` applies the same rule at parse time, so a training row and a
    parse of the same text pick the same script's system.
    """
    letters = [ch for ch in text if unicodedata.category(ch).startswith("L")]
    return bool(letters) and all(unicodedata.name(ch, "").startswith(("LATIN", "FULLWIDTH LATIN")) for ch in letters)


def address_system_id(country: str | None, text: str) -> int:
    """The id of the address system ``text`` follows for ``country``, or ``IGNORE_INDEX`` without one."""
    return address_system_for_country(country, latin=is_latin_text(text))
