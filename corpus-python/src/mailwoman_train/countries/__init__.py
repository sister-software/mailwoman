"""Per-country training code, keyed by ISO 3166-1 alpha-2.

One directory per country, and a country's own knowledge lives only there: its corpus builder, its
government register readers, its source samplers, the text handling its script needs. Two countries
never share a file. The FR title-caser that keeps particles lower case, the US per-state situs
layout and the GB Price Paid derivation were one module once, so a change to one country's source
edited the file the other two were read from.

Shared machinery stays in the role directories at the package root — `text/` for script
normalization, `corpora/` for the row builders, the record verifier and the country-agnostic
address-point sampler, `tokenizer/` for encoding.

Countries divide by what they provide:

- `COUNTRY_MODULES` — a country with its own corpus builder, label set and board floor. It
  satisfies `protocols.CountryModule`, and a caller reads all of that through four names.
- `SOURCE_ONLY` — a country that contributes readers or samplers into a corpus another module
  assembles, and whose rows train under a shared head. It has no label set of its own to declare.

`cjk/` is neither: it is a regional grouping, the shape `packages/corpus/lib/south-asia/` has on
the TypeScript side. Nothing addresses mail to a region.
"""

from __future__ import annotations

from ..protocols import CountryModule
from . import jp, kr, tw

COUNTRY_MODULES: dict[str, CountryModule] = {
    "jp": jp,
    "kr": kr,
    "tw": tw,
}

#: Codes whose directory contributes sources only. Listed rather than inferred, so a country
#: directory that MEANT to declare a label set and forgot is a failure rather than a silent
#: demotion — `test_country_registry` refuses a directory in neither group.
SOURCE_ONLY = frozenset({"de", "fr", "gb", "us"})

#: Directories under here that are regional groupings rather than countries.
REGIONS = frozenset({"cjk"})


def country_module(code: str) -> CountryModule:
    """The country module for an alpha-2 code, in either case.

    Raises `KeyError` naming the codes that do exist. A caller holding a code from a config or a
    filename gets told what it could have said, rather than a bare key in a traceback.
    """
    key = code.lower()
    if key not in COUNTRY_MODULES:
        known = ", ".join(sorted(COUNTRY_MODULES))
        extra = f" ({code.lower()} contributes sources only)" if key in SOURCE_ONLY else ""
        raise KeyError(f"no country module for {code!r}{extra}; known codes: {known}")
    return COUNTRY_MODULES[key]
