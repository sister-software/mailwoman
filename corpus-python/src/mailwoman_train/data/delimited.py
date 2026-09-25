"""Reading a delimited corpus file that may be zstd-compressed at rest.

The corpus part files are stored as ``.jsonl.zst`` because the rows repeat heavily —
measured 20.6x on ``br.corpus.jsonl`` and 25.1x on ``overture-jp.corpus.jsonl``. Every consumer
streams them line by line, which is what makes that safe: no reader here, and no reader
on the TypeScript side, seeks into one.

The equivalent on the TypeScript side is ``@mailwoman/core/fs/delimited``. Both must
agree on the extension, or a part file written by one is invisible to the other.
"""

from __future__ import annotations

import io
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

ZSTD_EXTENSION = ".zst"

# Python 3.14 has `compression.zstd` in the standard library. This is 3.12, so the
# dependency is required rather than optional. Importing lazily keeps the cost off
# the modules that never touch a compressed part file.


def open_delimited(path: Path, encoding: str = "utf-8") -> io.TextIOBase:
    """Open a delimited file for reading, transparently decompressing a ``.zst``.

    Returns a streaming text handle in both cases. The decompressed text is never
    materialised: a corpus part is tens of gigabytes expanded.
    """
    if path.suffix != ZSTD_EXTENSION:
        return path.open(encoding=encoding)

    import zstandard

    reader = zstandard.ZstdDecompressor().stream_reader(path.open("rb"))

    return io.TextIOWrapper(reader, encoding=encoding)


def prefer_compressed(path: Path) -> Path:
    """The path to read, preferring a ``.zst`` sibling when one exists.

    Lets the corpus be converted one part file at a time: a reader asks for ``part-0000.jsonl``
    and gets the compressed copy once the conversion has reached it.
    """
    if path.suffix == ZSTD_EXTENSION:
        return path

    compressed = path.with_suffix(path.suffix + ZSTD_EXTENSION)

    return compressed if compressed.exists() else path


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    """Stream one JSONL file, compressed or not, one parsed row at a time.

    Callers name the plain ``.jsonl``; a ``.zst`` sibling is preferred when one is on
    disk, so a corpus converted in place reads exactly like one that was not.
    """
    with open_delimited(prefer_compressed(path)) as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)
