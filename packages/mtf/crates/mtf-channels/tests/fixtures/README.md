# mtf-channels test fixtures

Both files are records of the training encoder this crate replaced (#2870). They were written from
that implementation before its deletion, so they're not regenerated. Each file states the source revision
it was recorded at.

- `encode-row-reference.json` holds one row encoded by the Python `encode_row` with every soft-feed
  channel on, under both label sources, with the shaped anchor and with no channels. It also holds every
  input the encoder read: pieces, lexicons, the anchor table and the label table. The postal anchor
  paints the shaped case's row identically, and the test says so.
- `text-reference.json` holds the code units and `str.lower`, `str.upper` and `str.strip` results for a
  list of adversarial texts. For each of 17 templates, it groups every Unicode scalar value by the
  segmentation that value gives when placed in the template. The recording also held the retired shape
  finder's spans and each unit's acceptance count, which the `postal` family's finders replaced, so those
  answers were removed from the file.

The postal finders' own fixture is `test/fixtures/postcode-agreement.json` at the repository root, beside the
code-unit parity fixture. `tests/postcode_agreement.rs` replays it against the encoder's finder and
`packages/postcode/lib/postal-spans.test.ts` against serving's.
