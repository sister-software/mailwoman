# `wof-postalcode` adapter

Emits `postcode → locality / region / country` pairings from a Who's On
First postalcode SQLite distribution.

## Input

A `.spatial.db` from one of the WOF postalcode distros:

- US: <https://dist.whosonfirst.org/sqlite/whosonfirst-data-postalcode-us-latest.db.bz2>
- FR: <https://dist.whosonfirst.org/sqlite/whosonfirst-data-postalcode-fr-latest.db.bz2>

Decompress (`bzip2 -d`) and point `--input` at the resulting `.db`.

The adapter only consults the `spr` table; it does **not** consult geometry,
GeoJSON, or names — the postcode hierarchy is enough for Phase 1.

## Expected schema (subset)

Same `spr` table the wof-admin adapter uses; the relevant `placetype` here is
`postalcode`, with `parent_id` pointing at the locality (city) the postcode
belongs to. Locality / region / country ancestry is resolved by walking
`parent_id` upward.

## Output

Per live postalcode row, four hierarchical variants when the ancestry is
fully present:

| Variant suffix                 | Components                                  |
| ------------------------------ | ------------------------------------------- |
| `self`                         | `postcode`                                  |
| `with-locality`                | `postcode`, `locality`                      |
| `with-locality-region`         | `postcode`, `locality`, `region`            |
| `with-locality-region-country` | `postcode`, `locality`, `region`, `country` |

`source_id` is `wof-postalcode-<wof_id>-<variant>`. `license` is `CC0-1.0`.

Rendering uses `formatAddress`, so FR rows look like `75008 Paris,
Île-de-France, France` and US rows look like `Portland, Oregon 97214`.

## Known quirks

- Real WOF postcode distros include WOF postcode rows for non-deliverable
  codes (e.g. PO Box exclusive codes). They're emitted just like normal
  postcodes; synthesis can filter on a per-row attribute later if needed.
- Some FR postcodes share a `parent_id` (one commune → many postcodes). The
  adapter does not deduplicate — each postcode emits its own variants.

## Fixture

`fixtures/wof-postalcode/fixture.sql` (hand-crafted, CC0, < 2 KB) covers US
postcodes for Portland + Burlington and FR postcodes for Paris + Lyon. The
fixture inlines the admin ancestry (country / region / locality) in the same
table so the adapter only needs one DB. Includes one superseded postcode to
exercise the `is_current` filter.
