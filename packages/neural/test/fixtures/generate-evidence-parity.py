"""Generate the TS↔Python EVIDENCE-CHANNEL parity fixture (Option-A Phase 2).

Paints a probe set with MINI street-type + locality-surface lexicons through corpus-python's REAL
painter (`mailwoman_train.gazetteer_anchor.realign_gazetteer_to_pieces`) against the in-repo fixture
tokenizer, and snapshots per-piece features + confidence. The TS test
(`neural/evidence-inference.test.ts`) replays the SAME lexicons + piece offsets through
`buildGazetteerFeatures` and asserts byte equality — the train/inference painter-parity guard the
productionization plan's Phase 2 mandates.

The probe set deliberately carries: hyphenated + apostrophe surfaces (the fold class a Phase-1
defect made unreachable), uppercase-gated short codes, homograph bits, multi-token longest-first
matches, the lowercase register (operator doctrine), and negative rows.

Run (from repo root):
    PYTHONPATH=corpus-python/src corpus-python/.venv/bin/python \
        neural/test/fixtures/generate-evidence-parity.py
"""

import json
from pathlib import Path

from mailwoman_train.gazetteer_anchor import GazetteerLexicon, realign_gazetteer_to_pieces
from mailwoman_train.tokenizer import Tokenizer

FIXTURE_DIR = Path(__file__).parent
OUT = FIXTURE_DIR / "evidence-parity-v2.json"

STREET_LEXICON = {
    "feature_dim": 1,
    "slots": ["street_type"],
    "bits": {"street_type": 1},
    "max_ngram": 2,
    "entries": {
        "rue": 1,
        "boulevard": 1,
        "impasse": 1,
        "chemin": 1,
        "street": 1,
        "ancien chemin": 1,  # multi-token, longest-first
    },
    "code_entries": {"R": 1, "AV": 1, "ST": 1},
    "rules": {"digit_guard": True},
}

LOCALITY_LEXICON = {
    "feature_dim": 2,
    "slots": ["locality", "locality_homograph"],
    "bits": {"locality": 1, "locality_homograph": 2},
    "max_ngram": 3,
    "entries": {
        "paris": 3,
        "springfield": 3,
        "rennes": 1,
        "saint-denis": 3,  # hyphenated — the painter-fold class
        "l'isle-adam": 1,  # apostrophe + hyphen
        "la grange park": 1,  # 3-token longest-first
        "belleville": 3,
    },
    "code_entries": {},
    "rules": {"digit_guard": True},
}

PROBES = [
    "12 rue de la Paix, Paris",
    "12 rue de la paix, paris",  # the lowercase register (operator doctrine)
    "Boulevard des Capucines",
    "Saint-Denis",
    "saint-denis",
    "L'Isle-Adam",
    "123 Main ST",  # uppercase code fires
    "123 main st",  # lowercase does NOT (code_entries case discipline)
    "La Grange Park Illinois",
    "Ancien Chemin de Rennes",
    "Springfield",
    "nothing to see here",
    "Chemin de Belleville",
    # Digit-guard probes (v3.23): matched spans beside/containing digits must paint NOTHING.
    "Springfield 62704",  # trailing digit neighbor guards the locality match
    "12b rue du Springfield",  # alnum house number guards "rue"; "Springfield" (neighbor "du") still paints
    "Boulevard 7 des Capucines",  # digit inside the neighborhood of both matches
    "Ancien Chemin 3 de Rennes",  # digit splits the 2-gram; guarded 1-gram consumption semantics
]


def to_lexicon(raw: dict) -> GazetteerLexicon:
    return GazetteerLexicon(
        feature_dim=raw["feature_dim"],
        slots=tuple(raw["slots"]),
        bits=raw["bits"],
        max_ngram=raw["max_ngram"],
        entries=raw["entries"],
        code_entries=raw["code_entries"],
        digit_guard=bool(raw.get("rules", {}).get("digit_guard", False)),
    )


def main() -> None:
    tok = Tokenizer(FIXTURE_DIR / "tokenizer-v0.1.0.model")
    street = to_lexicon(STREET_LEXICON)
    locality = to_lexicon(LOCALITY_LEXICON)
    cases = []
    for raw in PROBES:
        pieces = tok.encode_with_spans(raw)
        sfeat, sconf = realign_gazetteer_to_pieces(raw, list(pieces), street)
        lfeat, lconf = realign_gazetteer_to_pieces(raw, list(pieces), locality)
        cases.append(
            {
                "raw": raw,
                "pieces": [{"piece": p.piece, "start": p.char_begin, "end": p.char_end} for p in pieces],
                "street": {"features": sfeat, "confidence": sconf},
                "locality": {"features": lfeat, "confidence": lconf},
            }
        )
    OUT.write_text(
        json.dumps(
            {
                "generated_by": "neural/test/fixtures/generate-evidence-parity.py",
                "street_lexicon": STREET_LEXICON,
                "locality_lexicon": LOCALITY_LEXICON,
                "cases": cases,
            },
            indent=1,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT} ({len(cases)} cases)")


if __name__ == "__main__":
    main()
