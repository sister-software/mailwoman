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

The 23 curated category records (curated hierarchies, `osmTag`s, `overtureCategories` rollups, and the 6
`mailwoman-infra` street-furniture classes) plus the 35 synonym phrases. This is the source of truth for the curated
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

## `venue-word-hints.json` — the mined single-token venue-class hint table

Produced by `scripts/build-venue-word-hints.ts` from the f6 venue-word survey artifact
(`$MAILWOMAN_DATA_ROOT/derived/venue-word-lexicon-f6.json`, md5 `a2ae6f4b29ee0ee45870273487d86e79`).
**Do not hand-edit.** The survey compared token rates across 13.68M Overture poi names (the poi.db
build corpus, CDLA-Permissive-2.0) against 4.8M candidate-gazetteer primary place names; the
committed slice keeps the 2,249 tokens that clear the composed bars recorded in the file's own
provenance block (venue ratio ≥ 0.9 at ≥ 100 poi occurrences, top CLASS share ≥ 0.7 excluding
`other`, place rate ≤ 5 ppm — the toponym suppressor). Generated 2026-08-12. Regenerate with:

```bash
node poi-taxonomy/scripts/build-venue-word-hints.ts && npx oxfmt poi-taxonomy/data/venue-word-hints.json
```

No OSM-derived data: the survey's corpora are Overture poi names and the gazetteer's own primary
names, so the table carries no ODbL obligation.
