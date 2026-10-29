"""Per-country training code, keyed by ISO 3166-1 alpha-2.

Each country has one directory for its own knowledge. Two countries never share a file. The corpus
assemblers moved to `packages/corpus/lib/<cc>/corpus`, so what remains here are staging verifiers, the
Japanese probe corpora and the German fragment board.

Code that several countries share stays in the role directories at the package root — `text/` for script normalization,
`corpora/` for the row builders and the record verifier,
`tokenizer/` for encoding.

`SOURCE_ONLY` names each country directory. `cjk/` is a regional grouping, like
`packages/corpus/lib/south-asia/` on the TypeScript side. Mail addresses name countries rather than regions.
"""

from __future__ import annotations

#: Every country directory. Listed rather than inferred, so `test_country_registry` refuses a directory
#: that is not declared here.
SOURCE_ONLY = frozenset({"de", "jp", "kr", "tw"})

#: Directories under here that are regional groupings rather than countries.
REGIONS = frozenset({"cjk"})
