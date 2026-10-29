"""The committed Rust string tables equal what this interpreter computes over every scalar value.

`mtf-channels` splits words, strips punctuation, lowercases lexicon keys and matches postcode shapes with tables
generated from the reference interpreter. A different Unicode database would encode some rows differently, so an
interpreter whose tables differ from the committed ones fails here, before it trains on them.
"""

from __future__ import annotations

import unicodedata

import mailwoman_mtf

from mailwoman_train.text.python_text_tables import is_case_ignorable, main


def test_the_committed_tables_match_every_scalar_value() -> None:
    assert main(["--check"]) == 0


def test_the_extension_was_built_from_tables_of_this_unicode_version() -> None:
    assert mailwoman_mtf.UNICODE_VERSION == unicodedata.unidata_version


def test_case_ignorable_is_read_from_the_final_sigma_rule() -> None:
    assert is_case_ignorable("'") and is_case_ignorable("́")
    assert not is_case_ignorable("A") and not is_case_ignorable(" ")
