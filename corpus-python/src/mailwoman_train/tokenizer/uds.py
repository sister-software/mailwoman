"""The strings SentencePiece must keep whole, and how they reach it.

A user-defined symbol bypasses unigram inference and is always emitted as one piece. Two things
about them are easy to get wrong and both live here: the LITERAL a caller writes is not the literal
SentencePiece matches (it normalizes whitespace to ``▁`` first), and the UDS count competes with
the vocabulary budget, so an oversized list aborts the trainer rather than being trimmed.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

# Default user-defined symbols ("must keep whole"). SentencePiece UDS are literal strings
# that bypass unigram inference and are always emitted as a single piece. We use them for
# anchor patterns that should never fragment across sub-pieces:
#
# - **Country abbreviations** the corpus mentions but the unigram model might split.
# - **US state codes** (50 + DC) — short two-letter chunks adjacent to postcodes; without
#   UDS the unigram tokenizer can fragment ``NY 10001`` into ``N`` + ``Y`` + `` 10001``
#   under some merges. Keeping state codes atomic preserves the region→postcode adjacency
#   the classifier relies on.
# - **Common postal markers** (PO Box, Cedex, BP) — fixed surface forms; cheaper to put in
#   the vocab once than to learn them from frequency.
# - **JP postcode hyphen anchor** (``-``) we don't include here because ``-`` already
#   tokenizes as a single piece; the JP 100-0005 *whole-postcode* coverage comes from
#   corpus-mined postcode literals (see ``mine_postcode_literals``).
#
# Callers can extend or replace this set via ``--user-defined-symbols-file`` (one literal
# per line, blank lines + ``#``-comments ignored).
DEFAULT_USER_DEFINED_SYMBOLS: tuple[str, ...] = (
    # US states
    "AL",
    "AK",
    "AZ",
    "AR",
    "CA",
    "CO",
    "CT",
    "DE",
    "FL",
    "GA",
    "HI",
    "ID",
    "IL",
    "IN",
    "IA",
    "KS",
    "KY",
    "LA",
    "ME",
    "MD",
    "MA",
    "MI",
    "MN",
    "MS",
    "MO",
    "MT",
    "NE",
    "NV",
    "NH",
    "NJ",
    "NM",
    "NY",
    "NC",
    "ND",
    "OH",
    "OK",
    "OR",
    "PA",
    "RI",
    "SC",
    "SD",
    "TN",
    "TX",
    "UT",
    "VT",
    "VA",
    "WA",
    "WV",
    "WI",
    "WY",
    "DC",
    "PR",
    "VI",
    "GU",
    "AS",
    "MP",
    # Country abbreviations / common names
    "USA",
    "US",
    "U.S.",
    "U.S.A.",
    "FR",
    "FRA",
    "France",
    "JP",
    "JPN",
    "Japan",
    "GB",
    "UK",
    "U.K.",
    "DE",
    "DEU",
    "Germany",
    "IT",
    "ITA",
    "Italy",
    "ES",
    "ESP",
    "Spain",
    "NL",
    "NLD",
    "Netherlands",
    "CA",
    "CAN",
    "Canada",
    "AU",
    "AUS",
    "Australia",
    "CH",
    "CHE",
    "Switzerland",
    "BE",
    "BEL",
    "Belgium",
    "AT",
    "AUT",
    "Austria",
    "SE",
    "SWE",
    "Sweden",
    "RU",
    "RUS",
    # Postal-form anchors
    "PO Box",
    "P.O. Box",
    "P.O.Box",
    "POB",
    "Apt",
    "Apt.",
    "Suite",
    "Ste",
    "Cedex",
    "CEDEX",
    "BP",
)


def parse_user_defined_symbols_file(path: Path) -> list[str]:
    """One literal per line; blank lines + ``#``-comments ignored. Whitespace stripped only
    at line ends (a UDS may itself contain spaces like ``PO Box``)."""
    out: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.rstrip()
        if not s or s.lstrip().startswith("#"):
            continue
        out.append(s)
    return out


# U+2581 LOWER ONE EIGHTH BLOCK is SentencePiece's whitespace placeholder. UDS literals
# that contain ASCII spaces must use this codepoint instead — SP normalizes all whitespace
# to ▁ before matching, so a UDS like ``"PO Box"`` would never fire (the encoder sees
# ``"PO▁Box"`` internally but the UDS in the vocab is still ``"PO Box"``). We substitute
# transparently so callers can write natural strings.
_SP_WHITESPACE = "▁"


def _normalize_uds_for_sp(s: str) -> str:
    """Convert ASCII spaces to SentencePiece's ``▁`` whitespace placeholder."""
    return s.replace(" ", _SP_WHITESPACE)


def _dedupe_keep_order(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in items:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out
