"""Script-level text normalization, shared across countries.

`kana` folds half-width katakana and converts kanji numerals; `normalize` handles the cases every
script meets. Normalization only one country needs stays with that country in
`countries/<code>/text.py`. A government-register reader can normalize a name without importing a corpus
builder.
"""
