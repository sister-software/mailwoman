"""Script-level text normalization, shared across countries.

A corpus builder is not a home for a helper five modules need. These names lived in
`build_jp_slice.py`, which is why a government-register reader imported a corpus builder to get
`normalize_name`. Country-specific normalization stays with its country.
"""
