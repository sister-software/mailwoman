# `wof-postalcode` adapter (JSON-bundle)

Emits `postcode → locality / region / country` pairings from per-record
GeoJSON bundles published as
`github.com/whosonfirst-data/whosonfirst-data-postalcode-<cc>` repos.

This replaces the Phase 1.5 SpatiaLite-backed implementation. See
`DECISIONS.md` (2026-05-17 entry on the SQLite → JSON-bundle pivot) for the
rationale.

## Input

A directory containing one or more cloned `whosonfirst-data-postalcode-*`
repos **plus** the relevant `whosonfirst-data-admin-*` repos. The postcode
records reference their admin ancestry by `wof:parent_id`, so the locality /
region / country records must be in the same walk for the ancestry chain to
resolve:

```
<inputPath>/
├── whosonfirst-data-admin-us/
├── whosonfirst-data-admin-fr/
├── whosonfirst-data-postalcode-us/
└── whosonfirst-data-postalcode-fr/
```

Use the patched `mailwoman wof sync --repos <comma-separated>` flag to clone
only those four repos. See the `wof-admin` README for the full command.

## Recognized properties

Same as `wof-admin` (`wof:id`, `wof:name`, `wof:placetype`, `wof:country`,
`wof:parent_id`, `mz:is_current`, `name:*`). The relevant `wof:placetype` for
emission is `postalcode`; locality / region / country records are kept in the
index for ancestry resolution but are not themselves emitted by this adapter
(the `wof-admin` adapter handles those).

## Hierarchy variants

| Variant suffix                 | Components                                  |
| ------------------------------ | ------------------------------------------- |
| `self`                         | `postcode`                                  |
| `with-locality`                | `postcode`, `locality`                      |
| `with-locality-region`         | `postcode`, `locality`, `region`            |
| `with-locality-region-country` | `postcode`, `locality`, `region`, `country` |

## Name-variant slots

Postcode features rarely carry `name:*` variants in practice — the postcode
itself is a numeric / alphanumeric identifier that doesn't localize. The
adapter still iterates name slots for symmetry with the admin adapter, so
if a future distribution does include them they flow through unchanged.

Ancestor names (locality, region, country) always come from the canonical
`wof:name` field on the ancestor record. Cross-product over ancestor
`name:*` variants (e.g. emitting `"75008 Париж"` because Paris has a
`name:rus_x_preferred`) is **not** done here — that's a synthesis-step
augmentation, not an adapter responsibility. Multiplying postcode rows by
ancestor locale would inflate the corpus by an order of magnitude without
a clear training-value story; if it turns out we need it, the synthesis
pipeline (`packages/corpus/src/synthesize.ts`) is the right place.

## `source_id` format

`wof-postalcode-<wof_id>-<name-slot>-<hierarchy-variant>`. The `name-slot`
segment is almost always `default` for postcode records (see above).

## `is_current` semantics

Same as `wof-admin`: `1` and `-1` keep, `0` drops. The Geocode-Earth-hosted
WOF postalcode distros tag every row `-1`, which is why the previous SQLite
adapter's `is_current = 1` predicate silently emitted zero rows from
production.

## Fixture

`fixtures/wof-postalcode-json/` holds four cloned-repo skeletons (US + FR,
admin + postalcode). US postcodes: 97214 + 97215 (Portland OR), 33701
(Saint Petersburg FL). FR postcodes: 75008 + 75001 (Paris). Plus one
superseded postcode (`5099`, `mz:is_current = 0`) to exercise the filter.

The Saint Petersburg admin record in the fixture carries
`name:eng_x_colloquial = ["St. Petersburg"]` to verify that the postcode
adapter does **not** cross-multiply over ancestor name variants.
