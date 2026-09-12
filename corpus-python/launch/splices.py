"""Which checkpoint grows onto which tokenizer: the splice table, and nothing that runs.

A splice is five paths and a pair of vocabulary sizes. Seven of these existed as seven Modal
functions differing only in those values, which is how the size a splice is EXPECTED to produce
stayed in a docstring where nothing could check it. Here the expectation is data, `launch/mean_init.py`
refuses a result that does not match it, and `tests/launch/test_splices.py` checks the table's own
shape — a silent short expansion is a fine-tune that trains a head against rows the tokenizer never
emits.

No Modal import, for the reason `plan.py` has none: the SDK is installed wherever `modal run` runs
and not in this checkout's environment, so a table that imported it could not be tested at all.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Where a tokenizer directory lives on the volume, relative to the mount. Every splice names two.
TOKENIZERS = "models/tokenizer"


@dataclass(frozen=True)
class Splice:
    """One embedding expansion: whose weights, from which vocabulary to which, and where it lands."""

    #: Volume-relative directory holding the checkpoint whose embeddings grow.
    checkpoint: str
    #: The tokenizer the checkpoint was trained against, and the wider one it is grown onto.
    from_tokenizer: str
    to_tokenizer: str
    #: Volume-relative directory the expanded checkpoint is written to.
    destination: str
    #: The (old, new) vocabulary sizes this splice must produce, when they were measured. A splice
    #: that lands a different pair is refused rather than reported: the fine-tune that follows would
    #: train a head against rows the tokenizer never emits.
    vocabulary: tuple[int, int] | None
    #: What the wider tokenizer adds, in one line.
    adds: str


#: Keyed by the name that followed `mean_init_` on the function each replaces.
SPLICES: dict[str, Splice] = {
    "nsplice": Splice(
        checkpoint="models/bsplice-expanded",
        from_tokenizer="v0.6.0-bsplice",
        to_tokenizer="v0.7.1-nsplice",
        destination="models/nsplice-v2-expanded",
        vocabulary=None,
        adds="the nsplice vocabulary, over the shipped bsplice-expanded checkpoint (#912 setting 4)",
    ),
    "fr_nsplice": Splice(
        checkpoint="output-v230-nl-postcode-full-s42/checkpoints/step-005000",
        from_tokenizer="v0.7.1-nsplice",
        to_tokenizer="v0.8.0-fr-nsplice",
        destination="models/fr-nsplice-expanded",
        vocabulary=(63913, 66319),
        adds="FR diacritic pieces; the init_from base for v2.4.1-fr-nsplice-ft (#444)",
    ),
    "multisplice": Splice(
        checkpoint="output-v241-fr-nsplice-ft-s42/checkpoints/step-012000",
        from_tokenizer="v0.8.0-fr-nsplice",
        to_tokenizer="v0.9.0-multisplice",
        destination="models/multisplice-expanded",
        vocabulary=(66319, 73143),
        adds="12-locale diacritic pieces plus a pt/no top-up; the init_from base for v2.5.1-fragment-splice",
    ),
    "numsplice": Splice(
        checkpoint="output-v310-fr-fragment-s42/checkpoints/step-008000",
        from_tokenizer="v0.9.0-multisplice",
        to_tokenizer="v0.11.0-numsplice",
        destination="models/numsplice-expanded",
        vocabulary=(73143, 83131),
        adds="word-start number pieces 10-9999 — a closed numeric manifold, unlike the letter families",
    ),
    "numsplice3": Splice(
        checkpoint="output-v310-fr-fragment-s42/checkpoints/step-008000",
        from_tokenizer="v0.9.0-multisplice",
        to_tokenizer="v0.11.1-numsplice3",
        destination="models/numsplice3-expanded",
        vocabulary=(73143, 74043),
        adds="word-start 100-999 only, so 4-5 digit postcodes stay multi-piece and keep their length signal",
    ),
    "numsplice23": Splice(
        checkpoint="output-v310-fr-fragment-s42/checkpoints/step-008000",
        from_tokenizer="v0.9.0-multisplice",
        to_tokenizer="v0.11.2-numsplice23",
        destination="models/numsplice23-expanded",
        vocabulary=(73143, 74131),
        adds="word-start 10-999, adding the 2-digit pieces the 3-digit split forgoes",
    ),
    "ptro": Splice(
        checkpoint="output-v381-punct-fix-full-s42/checkpoints/step-008000",
        from_tokenizer="v0.9.0-multisplice",
        to_tokenizer="v0.12.0-ptro-splice",
        destination="models/ptro-expanded",
        vocabulary=(73143, 75453),
        adds="2,310 PT/RO diacritic pieces; RO comma-below characters were byte-fallback before",
    ),
}
