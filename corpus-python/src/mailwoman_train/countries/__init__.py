"""Per-country training code, keyed by ISO 3166-1 alpha-2.

One directory per country, and a country's own knowledge lives only there: its corpus builder, its
government register readers, its source samplers, the text handling its script needs. Two countries
never share a file.

Shared machinery stays in the role directories at the package root — `text/` for script normalization,
`corpora/` for the row builders, the record verifier and the country-agnostic address-point sampler,
`tokenizer/` for encoding.

Countries divide by what they provide: `COUNTRY_MODULES` names a country with its own corpus builder,
label set and board floor (satisfying `protocols.CountryModule`); `SOURCE_ONLY` names a country that
contributes readers or samplers into a corpus another module assembles and has no label set of its own.
`cjk/` is neither — it is a regional grouping, like `packages/corpus/lib/south-asia/` on the TypeScript
side, and no mail is addressed to a region.
"""

from __future__ import annotations

from ..protocols import CountryModule
from . import jp, kr, tw

COUNTRY_MODULES: dict[str, CountryModule] = {
    "jp": jp,
    "kr": kr,
    "tw": tw,
}

#: Codes whose directory contributes sources only. Listed rather than inferred, so a directory that
#: meant to declare a label set is a failure rather than a silent demotion; `test_country_registry`
#: refuses a directory in neither group.
SOURCE_ONLY = frozenset({"de", "fr", "gb", "us"})

#: Directories under here that are regional groupings rather than countries.
REGIONS = frozenset({"cjk"})


def country_module(code: str) -> CountryModule:
    """The country module for an alpha-2 code, in either case. Raises `KeyError` naming the codes that do exist."""
    key = code.lower()
    if key not in COUNTRY_MODULES:
        known = ", ".join(sorted(COUNTRY_MODULES))
        extra = f" ({code.lower()} contributes sources only)" if key in SOURCE_ONLY else ""
        raise KeyError(f"no country module for {code!r}{extra}; known codes: {known}")
    return COUNTRY_MODULES[key]
