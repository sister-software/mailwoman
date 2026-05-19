# `wof-admin` adapter (JSON-bundle)

Emits administrative-hierarchy rows from per-record GeoJSON bundles published
as `github.com/whosonfirst-data/whosonfirst-data-admin-<cc>` repos.

This replaces the Phase 1.5 SpatiaLite-backed implementation. See
`DECISIONS.md` (2026-05-17 entry on the SQLite → JSON-bundle pivot) for the
rationale.

## Input

A directory containing one or more cloned `whosonfirst-data-admin-*` repos:

```
<inputPath>/
├── whosonfirst-data-admin-us/
│   └── data/856/337/93/85633793.geojson
│   └── data/...
└── whosonfirst-data-admin-fr/
    └── data/...
```

`<inputPath>` is the directory you handed `mailwoman wof sync` — the corpus
pipeline clones the admin + postcode repos into a shared
`/data/corpus/sources/wof/repos/whosonfirst-data/` root and the adapter walks
that root recursively (`**/*.geojson`).

Use the patched `mailwoman wof sync --repos <comma-separated>` flag to clone
only the four repos the corpus build needs (~2.9 GB) rather than all ~100
non-archived repos in the org:

```sh
mailwoman wof sync /data/corpus/sources/wof/ \
  --repos whosonfirst-data-admin-us,whosonfirst-data-admin-fr,\
whosonfirst-data-postalcode-us,whosonfirst-data-postalcode-fr
```

## Recognized properties

Per WOF feature, the adapter consults:

| Property          | Use                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `wof:id`          | Record id (also accepts the GeoJSON top-level `id` field as a fallback)                                  |
| `wof:name`        | Canonical name (one row per record uses this in the `default` slot)                                      |
| `wof:placetype`   | Mapped to a `ComponentTag` per the table below; unknown placetypes are skipped                           |
| `wof:country`     | ISO 3166-1 alpha-2; stamped onto every row                                                               |
| `wof:parent_id`   | Walked upward to build the ancestry chain                                                                |
| `mz:is_current`   | `1` or `-1` → keep; `0` → drop. `-1` ("unknown but treated as active") is WOF's default for many distros |
| `name:eng_x_*`, … | Localized name variants; each produces an additional emission slot for the record's own component        |

## Placetype mapping

| WOF placetype                                        | ComponentTag         |
| ---------------------------------------------------- | -------------------- |
| `country`, `nation`                                  | `country`            |
| `macroregion`, `region`                              | `region`             |
| `macrocounty`, `county`, `localadmin`                | `subregion`          |
| `locality`                                           | `locality`           |
| `borough`, `macrohood`, `neighbourhood`, `microhood` | `dependent_locality` |

Anything else is silently dropped.

## Hierarchy variants

| Placetype            | Variants                                                                      |
| -------------------- | ----------------------------------------------------------------------------- |
| `country`            | `self`                                                                        |
| `region`             | `self`, `with-country`                                                        |
| `subregion` (county) | `self`                                                                        |
| `locality`           | `self`, `with-region`, `with-region-country` (or `with-country` if no region) |
| `dependent_locality` | Same as `locality`                                                            |

## Name-variant slots (Phase 1.5.1)

For each record, the adapter emits **one row per name slot** in addition to
the per-hierarchy variants:

- `default`: the canonical `wof:name` (substituted with the OpenCage-canonical
  country name when the record is itself a country).
- One slot per `name:*` property whose value differs from `default`. Slot
  key is the property name with `:` and `_` rewritten to `-`, e.g.
  `name:eng_x_colloquial` → `name-eng-x-colloquial`.

This is the Phase 1.5.1 fix for the **St. Petersburg / Mt. Vernon /
Ft. Lauderdale** alternation: the canonical record has `wof:name = "Saint
Petersburg"`, and the property `name:eng_x_colloquial = ["St. Petersburg"]`.
Both surface forms become training rows for the same WOF id, so the model
sees both abbreviated and unabbreviated localities in supervised data.

`source_id` is `wof-admin-<wof_id>-<name-slot>-<hierarchy-variant>`. Each
combination survives canonical dedup independently.

## `is_current` semantics

WOF tags each record's `mz:is_current` as one of:

- `1` — current, in service.
- `-1` — unknown, treated as active. The official Pelias importer accepts
  these; the Phase 1.5 SQLite adapter did not, and silently emitted **zero
  rows** from the production distribution as a result.
- `0` — superseded. Skipped.

This adapter accepts `1` and `-1`, skipping only `0`.

## Output

`source_id` format: `wof-admin-<wof_id>-<name-slot>-<hierarchy-variant>`.
`license` is always `CC0-1.0` (WOF is CC0). `locale` is defaulted from
country: `US → en-US`, `FR → fr-FR`. Extend `LOCALE_BY_COUNTRY` in
`adapter.ts` as new locales come online.

Rendering uses `formatAddress`, so US rows look like `Portland, OR` and FR
rows look like `Paris, Île-de-France, France`.

## Known quirks

- The adapter holds an in-memory ancestry index (`Map<id, [parent, grandparent,
...]>`) keyed by every record it sees. For the full US admin distro
  (~270 k recognized records) this peaks at ~50 MB. The fully streaming
  alternative would require resolving parents lazily, which is more code
  for no real memory-budget win at corpus-build scale.
- Alternate-geometry sibling files (`<id>-alt-<source>-<lang>.geojson`) are
  identified by the `-alt-` substring in the filename and skipped. They are
  not separate records.
- The adapter walks `**/*.geojson` from `inputPath`, so it doesn't care about
  the directory structure WOF uses internally (`data/XXX/YYY/ZZZ/`). Tests
  use a flatter `data/<id>.geojson` layout for human-reviewable fixtures.

## Fixture

`fixtures/wof-admin-json/` holds two cloned-repo skeletons covering
US (Oregon → Multnomah → Portland, Florida → Saint Petersburg) and FR
(Île-de-France → Paris, Auvergne-Rhône-Alpes → Rhône → Lyon).

`Saint Petersburg` carries `name:eng_x_colloquial = ["St. Petersburg",
"St Pete"]` and `Portland` ships with an `<id>-alt-quattroshapes.geojson`
sibling to exercise the alt-skip behavior. One superseded record
(`1099.geojson`, `mz:is_current = 0`) exercises the `is_current` filter.
