# `wof-admin` adapter

Emits administrative hierarchy rows from a Who's On First (WOF)
`whosonfirst-data-admin-<cc>-latest.spatial.db` distribution.

## Input

A SpatiaLite-flavored SQLite file from one of the WOF admin distros. Only the
`spr` table is consulted; geometry, GeoJSON, names (localized variants), and
concordances are ignored. The adapter is `better-sqlite3`-only — no SpatiaLite
extension required at runtime.

Download links:

- US: <https://dist.whosonfirst.org/sqlite/whosonfirst-data-admin-us-latest.db.bz2>
- FR: <https://dist.whosonfirst.org/sqlite/whosonfirst-data-admin-fr-latest.db.bz2>

Decompress (`bzip2 -d`) and point `--input` at the resulting `.db` file.

## Expected schema (subset)

```sql
CREATE TABLE spr (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER,
  name        TEXT NOT NULL,
  placetype   TEXT NOT NULL,
  country     TEXT NOT NULL,   -- ISO 3166-1 alpha-2
  is_current  INTEGER NOT NULL DEFAULT 1
);
```

Only `is_current = 1` rows participate. Superseded records are skipped.

## Output

For every recognized placetype (`country`, `region`, `macroregion`, `county`,
`localadmin`, `macrocounty`, `locality`, `borough`, `neighbourhood`,
`microhood`, `macrohood`), the adapter walks `parent_id` upward and emits
hierarchical variants per the Phase 1 plan:

| Placetype            | Variants                                                                      |
| -------------------- | ----------------------------------------------------------------------------- |
| `country`            | `self`                                                                        |
| `region`             | `self`, `with-country`                                                        |
| `subregion` (county) | `self`                                                                        |
| `locality`           | `self`, `with-region`, `with-region-country` (or `with-country` if no region) |
| `dependent_locality` | Same as `locality`                                                            |

`source_id` is `wof-admin-<wof_id>-<variant>`. Each variant emits a row whose
`raw` field is rendered via `@mailwoman/corpus/format` (OpenCage templates)
with `separator: ", "`, so the corpus carries single-line strings.

`license` is always `CC0-1.0` (WOF is CC0). `locale` is defaulted from
`country`: `US → en-US`, `FR → fr-FR`. Extend `LOCALE_BY_COUNTRY` in
`adapter.ts` as new locales come online.

## Known quirks

- WOF country codes are alpha-2 uppercase; the fixture matches that. The
  adapter does no case normalization — assume upstream is well-formed.
- Country display name comes from the country row's `name` (e.g. "United
  States", "France"). Adapter does not localize.
- WOF admin distros tag `Paris` as a `locality`, not a `region` or
  `subregion`, even though Paris is administratively all three. The hierarchy
  is "Paris" (locality) → "Île-de-France" (region) → "France" (country); the
  adapter follows the placetype labels rather than trying to reconstruct
  political reality.

## Fixture

`fixtures/wof-admin/fixture.sql` (hand-crafted, CC0, < 1 KB) covers the US +
FR hierarchies needed for the integration test:

- US > Oregon > Multnomah County > Portland
- US > Vermont > Burlington
- FR > Île-de-France > Paris
- FR > Auvergne-Rhône-Alpes > Rhône > Lyon

Plus one superseded record to exercise the `is_current` filter.

The test materializes the fixture into a real SQLite DB at runtime
(`packages/corpus/src/adapters/wof-admin/adapter.test.ts`) — no binary `.db`
in git, keeping the fixture human-reviewable.
