"""Per-country training code, keyed by ISO 3166-1 alpha-2.

A country directory holds only what is specific to that country: its corpus builder, its government
register readers, and the text handling its script needs and no other country's does. Shared
machinery stays in the role directories at the package root — `text/` for script normalization,
`corpora/` for the row builders and the record verifier, `tokenizer/` for encoding.

Adding a country is a directory that satisfies `protocols.CountryModule` and one line in
`COUNTRY_MODULES`. The protocol is what makes the line enough: a caller reads a country's label set
and board floor through the same four names whichever country it holds.
"""

from __future__ import annotations

from ..protocols import CountryModule
from . import jp, kr, tw

COUNTRY_MODULES: dict[str, CountryModule] = {
    "jp": jp,
    "kr": kr,
    "tw": tw,
}


def country_module(code: str) -> CountryModule:
    """The country module for an alpha-2 code, in either case.

    Raises `KeyError` naming the codes that do exist. A caller holding a code from a config or a
    filename gets told what it could have said, rather than a bare key in a traceback.
    """
    key = code.lower()
    if key not in COUNTRY_MODULES:
        known = ", ".join(sorted(COUNTRY_MODULES))
        raise KeyError(f"no country module for {code!r}; known codes: {known}")
    return COUNTRY_MODULES[key]
