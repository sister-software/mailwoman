"""Country-lexicon input features (#1104) — the third atlas soft-feed channel.

The Python training-side mirror of ``neural/country-inference.ts``. Country is a CLOSED, ENUMERABLE
class (~250 surfaces) the learned GRAMMAR mislabels in the WOF-admin / resolver hierarchy case
("United States of America, Wyoming, <locality>" reads as a leading STREET). This channel injects the
atlas prior the tagger lacks: a per-piece clue that the piece is part of a recognized country surface
phrase. The clue INFORMS, the model decides (model-first) — the analogue of Pelias's
``WhosOnFirstClassifier`` dictionary lookup, rendered as an additive feature (see
docs/articles/plan/reference/closed-vocab-fields-model-first.mdx).

The matcher DELIBERATELY REUSES the gazetteer's phrase-scan (``gazetteer_char_paint``): one tested
longest-first n-gram algorithm, two vocabularies. Only the vocabulary
(``data/gazetteer/country-surface-lexicon-v1.json``, built by
``codex/tools/build-country-surface-lexicon.ts``) and the emitted 2-dim feature differ. The lexicon
JSON is the single source both consumers load (TS + Python), so the two implementations cannot drift
(the PLACETYPE_ORDER lesson); ``test_country_lexicon.py`` pins them to the TS fixture.

CRITICALLY, like the gazetteer and unlike the postcode anchor: features are computed from the RAW
SURFACE ONLY — never from gold labels — so the exact same computation runs at train and inference
(no leak, no skew). The emitted per-piece feature is ``[country_surface, country_ambiguous]``:

- ``country_surface`` (bit 1) — the piece is inside a recognized country surface phrase.
- ``country_ambiguous`` (bit 2) — the SURFACE is a homograph (also a US region) or a common-word
  name; a SOFT false-positive guard, the model-first analogue of Pelias's hard blacklist. The model
  learns to trust ``surface & !ambiguous`` strongly and ``surface & ambiguous`` weakly, via context.

WHY A DEDICATED CHANNEL rather than the gazetteer's existing ``country`` slot: the gazetteer slot
already carries these surfaces AND the shipped model already consumes them, yet the WOF-admin case
still fails (#1104). The country bit shares ONE projection with region/po_box/cedex/homograph and is
ZEROED adjacent to a postcode by ``suppress_gazetteer_near_postcode`` (exactly where "…12345 USA"
sits). A separate channel de-entangles the country signal and is immune to that suppression.
"""

from __future__ import annotations

from collections.abc import Sequence

from .gazetteer_anchor import GazetteerLexicon, gazetteer_char_paint, load_gazetteer_lexicon
from .tokenizer import PieceSpan

#: Emitted per-piece feature width: ``[country_surface, country_ambiguous]``.
COUNTRY_FEATURE_DIM = 2
#: Lexicon bit: the surface is a recognized country surface.
COUNTRY_SURFACE_BIT = 1
#: Lexicon bit: the surface is ambiguous (homograph with a US region, or a common-word name).
COUNTRY_AMBIGUOUS_BIT = 2

# The country lexicon is structurally identical to a GazetteerLexicon (the same n-gram phrase-scan
# shape) — the type + loader are reused deliberately so the two channels share ONE matcher.
CountryLexicon = GazetteerLexicon


def load_country_lexicon(path: str) -> CountryLexicon:
    """Load the codex-generated country lexicon JSON once at loader init."""
    return load_gazetteer_lexicon(path)


def realign_country_to_pieces(
    raw: str,
    pieces: Sequence[PieceSpan],
    lexicon: CountryLexicon,
) -> tuple[list[list[float]], list[float]]:
    """Project the char-painted country bits onto SP pieces.

    Mirrors ``realign_gazetteer_to_pieces`` / ``realign_anchor_to_pieces`` exactly: each piece
    inherits the bits of the first non-whitespace char it covers. Returns
    ``(features[n_pieces][2], confidence[n_pieces])`` — the emitted feature is
    ``[country_surface, country_ambiguous]`` and confidence is 1.0 wherever a country surface fires.
    """
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
