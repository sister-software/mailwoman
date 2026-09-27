from __future__ import annotations

from collections.abc import Sequence

from ..types import PieceSpan
from .gazetteer_anchor import GazetteerLexicon, gazetteer_char_paint, load_gazetteer_lexicon

COUNTRY_FEATURE_DIM = 2

COUNTRY_SURFACE_BIT = 1

COUNTRY_AMBIGUOUS_BIT = 2


CountryLexicon = GazetteerLexicon


def load_country_lexicon(path: str) -> CountryLexicon:
    return load_gazetteer_lexicon(path)


def realign_country_to_pieces(
    raw: str,
    pieces: Sequence[PieceSpan],
    lexicon: CountryLexicon,
) -> tuple[list[list[float]], list[float]]:
    char_bits, _ = gazetteer_char_paint(raw, lexicon)
    feats: list[list[float]] = []
    confs: list[float] = []
    for piece in pieces:
        bits = 0
        for c in range(piece.char_begin, piece.char_end):
            if c < len(raw) and not raw[c].isspace():
                bits = char_bits[c]
                break
        surface = 1.0 if bits & COUNTRY_SURFACE_BIT else 0.0
        ambiguous = 1.0 if bits & COUNTRY_AMBIGUOUS_BIT else 0.0
        feats.append([surface, ambiguous])
        confs.append(surface)
    return feats, confs
