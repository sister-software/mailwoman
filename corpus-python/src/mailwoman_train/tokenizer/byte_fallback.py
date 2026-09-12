"""How often a trained tokenizer falls back to raw bytes, overall and per script.

A byte-fallback piece is one character's byte emitted as its own token because the vocabulary held
nothing better. It is not an error — it is the reason a model can encode text it never saw — but a
high rate on a script means the vocabulary is spending the model's sequence budget on bytes. The
per-script split is what says WHERE, which the headline number cannot.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import sentencepiece as spm

# Byte-fallback pieces in a SentencePiece model are surface-form ``<0xNN>`` (one literal
# token per byte). Matching the surface form is more reliable than matching piece id ranges:
# the id range depends on where SP placed the byte block in the unigram vocab.
_BYTE_FALLBACK_RE = re.compile(r"^<0x[0-9A-Fa-f]{2}>$")


def detect_script(text: str) -> str:
    """Return a coarse script tag for a string: ``latin``, ``cjk``, ``cyrillic``, ``armenian``,
    ``arabic``, ``greek``, ``hebrew``, ``devanagari``, ``thai``, ``mixed``, or ``other``.

    Used to bucket the byte-fallback eval into per-script rates so the model card surfaces
    *where* the tokenizer hits byte fallback, not just the overall headline number.
    """
    blocks: Counter[str] = Counter()
    for ch in text:
        if ch.isspace() or unicodedata.category(ch).startswith(("N", "P", "Z", "S")):
            continue
        name = unicodedata.name(ch, "")
        if not name:
            blocks["other"] += 1
            continue
        if name.startswith(("LATIN", "FULLWIDTH LATIN")):
            blocks["latin"] += 1
        elif name.startswith(("CJK", "HIRAGANA", "KATAKANA", "HANGUL")):
            blocks["cjk"] += 1
        elif name.startswith("CYRILLIC"):
            blocks["cyrillic"] += 1
        elif name.startswith("ARMENIAN"):
            blocks["armenian"] += 1
        elif name.startswith("ARABIC"):
            blocks["arabic"] += 1
        elif name.startswith("GREEK"):
            blocks["greek"] += 1
        elif name.startswith("HEBREW"):
            blocks["hebrew"] += 1
        elif name.startswith("DEVANAGARI"):
            blocks["devanagari"] += 1
        elif name.startswith("THAI"):
            blocks["thai"] += 1
        else:
            blocks["other"] += 1
    if not blocks:
        return "other"
    if len(blocks) == 1:
        return next(iter(blocks))
    # If 90%+ of letter chars are in one block, call it that block (latin punctuation around
    # a CJK address shouldn't make it ``mixed``). Otherwise call it ``mixed``.
    total = sum(blocks.values())
    top, n = blocks.most_common(1)[0]
    return top if n / total >= 0.9 else "mixed"


def measure_byte_fallback(sp: spm.SentencePieceProcessor, lines: Iterable[str]) -> dict[str, Any]:
    """Encode each line and tally byte-fallback piece rate, overall + per script.

    Returns a dict shaped::

        {
          "overall": {"lines": n, "pieces": p, "byte_fallback_pieces": b, "rate": b/p},
          "per_script": {
              "latin":   {"lines": ..., "pieces": ..., "byte_fallback_pieces": ..., "rate": ...},
              "cjk":     {...},
              ...
          }
        }

    The "rate" denominator is piece count, not line count — a byte-fallback piece is a
    *piece*, not a *line*, so the rate that matters for downstream model wastage is the
    fraction of pieces that landed on the byte block.
    """
    overall = {"lines": 0, "pieces": 0, "byte_fallback_pieces": 0}
    per_script: dict[str, dict[str, int]] = {}

    for line in lines:
        line = line.strip()
        if not line:
            continue
        script = detect_script(line)
        bucket = per_script.setdefault(script, {"lines": 0, "pieces": 0, "byte_fallback_pieces": 0})
        pieces = sp.encode_as_pieces(line)
        npieces = len(pieces)
        nfb = sum(1 for p in pieces if _BYTE_FALLBACK_RE.match(p))

        overall["lines"] += 1
        overall["pieces"] += npieces
        overall["byte_fallback_pieces"] += nfb
        bucket["lines"] += 1
        bucket["pieces"] += npieces
        bucket["byte_fallback_pieces"] += nfb

    def _attach_rate(d: dict[str, int]) -> dict[str, float | int]:
        rate = d["byte_fallback_pieces"] / d["pieces"] if d["pieces"] > 0 else 0.0
        return {**d, "rate": rate}

    return {
        "overall": _attach_rate(overall),
        "per_script": {k: _attach_rate(v) for k, v in per_script.items()},
    }


def load_fixture_lines(path: Path) -> list[str]:
    """Load raws from a JSONL eval fixture, falling back to plain-text if not JSON."""
    lines: list[str] = []
    with path.open("r", encoding="utf-8") as fh:
        for raw_line in fh:
            raw_line = raw_line.rstrip("\n")
            if not raw_line:
                continue
            if raw_line.lstrip().startswith("{"):
                obj = json.loads(raw_line)
                v = obj.get("raw") or obj.get("text") or obj.get("input")
                if v:
                    lines.append(str(v))
            else:
                lines.append(raw_line)
    return lines
