"""Script-level text normalization, shared across countries.

`kana` folds half-width katakana and converts kanji numerals; `normalize` handles the cases every
script meets. Normalization only one country needs stays with that country, in
`countries/<code>/text.py` — a government-register reader should not have to import a corpus
builder to normalize a name.
"""
