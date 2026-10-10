# `data/` provenance

## `overture-categories.csv` — the Overture Places category snapshot

- **Source:** <https://raw.githubusercontent.com/OvertureMaps/schema/main/docs/schema/concepts/by-theme/places/overture_categories.csv>
- **Overture schema release:** `v1.17.0` (latest release 2026-05-19)
- **CSV last-modified commit:** `ac891b7f22486a6c96c1f6232461e7193263b184`
- **Retrieved:** 2026-07-20
- **Rows:** 2117 category rows (2118 lines including the header)
- **Format:** semicolon-delimited, BOM-prefixed — `<category code>; [<hierarchy,path,leaf>]`. The path's last element is
  the category code, except for 4 rows (`aircraft_repair`, `ev_charging_station`, `custom_t_shirt_store`,
  `community_services_non_profits`) whose display-path leaf differs from the stored code; the generator appends the
  code as the true leaf for those.
- **License:** CDLA-Permissive-2.0 (the Overture schema/taxonomy).

The old Overture `categories` property on the Places feature is retired in Overture's September 2026 release. This
snapshot is the vocabulary of the NEW `taxonomy` property, pinned here as committed data so the runtime never reaches
the network.

## `curated-overlay.json` — mailwoman's hand-maintained overlay

The 26 curated category records (curated hierarchies, `osmTag`s, `overtureCategories` rollups, and the 6
`mailwoman-infra` street-furniture classes) plus the 54 synonym phrases. This is the source of truth for the curated
layer; the generator merges it over the Overture snapshot.

## `taxonomy.json` — the generated, committed merge

Produced by `scripts/generate-taxonomy.ts` from the two inputs above. **Do not hand-edit.** Regenerate with:

```bash
node poi-taxonomy/scripts/generate-taxonomy.ts && npx oxfmt poi-taxonomy/data/taxonomy.json
# add --fetch to refresh the CSV from the source URL first:
node poi-taxonomy/scripts/generate-taxonomy.ts --fetch && npx oxfmt poi-taxonomy/data/taxonomy.json
```

The oxfmt pass is required because committed JSON must be oxfmt-clean (short arrays inline), which raw
`JSON.stringify` can't reproduce. The generator and oxfmt are both deterministic, so the committed artifact is
reproducible; `lookup.test.ts` asserts the committed table is content-identical to a fresh generate. Curated records win id collisions
with the snapshot, and Overture leaves already absorbed by a curated record's `overtureCategories` are not emitted as
standalone records (so a curated synonym like `coffee shop` → `cafe` is never shadowed by the `coffee_shop` snapshot
leaf). To edit the curated layer, change `curated-overlay.json` and regenerate.

## `brands.json` — the chain-brand table aggregated from `poi.db`

Produced by `mailwoman gazetteer build poi-brands`, whose aggregation lives in
`packages/mailwoman/tools/gazetteer-pipeline/poi/build/brands.ts`. **Do not hand-edit.** It reads a built
`poi.db` read-only and groups its `(brand_wikidata, name)` pairs into one record per Wikidata QID,
carrying the most frequently observed name plus the alias spellings that clear a noise floor.

The committed copy declares `version` `0.2.0` over source layer `poi` at vintage `2026-05-20.0`, which
is the field a reader checks it against.

A rebuild against the same `poi.db` is byte-identical. Every ordering decision is an explicit tie-break
rather than SQL row order or `Map` iteration order: brands by row count descending then QID ascending,
the modal name by count descending then name ascending, aliases alphabetical.

```bash
node packages/mailwoman/out/cli/main.js gazetteer build poi-brands
```

## `venue-heads.json`: venue head words per country and per language

Produced by `packages/mailwoman/tools/gazetteer-pipeline/poi/build/venue-heads.ts`. Do not edit it by
hand. The builder compares three populations of names per country:

- Venue names: the primary names of Overture places at confidence 0.85 or higher, release
  `2026-09-23.1`, CDLA-Permissive-2.0, fetched to
  `$MAILWOMAN_DATA_ROOT/overture/2026-09-23.1/place-names/names.parquet`.
- Place names: the Who's On First candidate database, `$MAILWOMAN_DATA_ROOT/db/wof/candidate.db`,
  with postal codes excluded.
- Street names: the street spans of the train split of corpus `0.7.2-address-systems`, excluding
  rows licensed under ODbL, rows whose license names OpenStreetMap, and rows with no recorded license.

The table records each population's size per country, so a country with no street spans is visible.
It holds words and rates only, and it carries no OpenStreetMap data.

A head is admitted when it is two or more characters long, when it is not an administrative name of
the country, and when its venue rate exceeds its rate at any position in the country's place names
and street names. The administrative names come from the candidate database's admin rows, from the
admin database `$MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority-importance.db` (every language's
name for each admin place in its `names` table and the abbreviations in `place_abbr`, so `Bayern`,
`Baviera`, `NSW` and `DC` are excluded in every country the database covers), and from the codex's
country display names in every ICU locale. A suffix is admitted when it ends at least `minSuffixStems` distinct
venue last words and, in a spaced script, is itself a venue last word with `minSupport` names, so a
city name cannot supply a suffix by itself. Regenerate with:

```bash
node packages/mailwoman/out/cli/main.js gazetteer build venue-heads && npx oxfmt packages/poi-taxonomy/data/venue-heads.json
```
