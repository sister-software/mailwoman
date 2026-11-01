# mtf-channels test fixtures

Both files are records of the Python training encoder this crate replaced (#2870). They were written from
that implementation before its deletion, so they are not regenerated. Each file states the source revision
it was recorded at.

- `encode-row-reference.json` holds one row encoded by the Python `encode_row` with every soft-feed
  channel on, under both label sources, with the shaped anchor and with no channels. It also holds every
  input the encoder read: pieces, lexicons, the anchor table and the label table.
- `python-reference.json` holds the Python postcode-shape matches, code units with acceptance counts, and
  `str.lower`, `str.upper` and `str.strip` results for a list of adversarial texts. For each of 17
  templates, it groups every Unicode scalar value by the answer that value gives when placed in the
  template.
