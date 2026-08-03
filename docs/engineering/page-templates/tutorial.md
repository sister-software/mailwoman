# Template: tutorial

A `tutorial` teaches by producing one finished artifact. The reader follows it start to finish, in order,
once. Register rules are in [`../writing-system.md`](../writing-system.md) under Register by role.

## Frontmatter skeleton

Copy this to the top of the new page. `verified-with` is required for this role and names the version the
captured output was produced against.

```yaml
---
title: Match a customer CSV to geocoded entities
description: Ingest a CSV, resolve duplicate records to one entity each, and export GeoJSON. About twenty minutes.
role: tutorial
verified-with: mailwoman v8.7.0
sidebar_position: 3
---
```

## Section order

1. `# Title` — a task, not a noun phrase.
2. **Lead.** What the reader will hold at the end, plus the reading time.
3. **Prerequisites.** Versions, downloads, and every hard constraint that would break a step below.
4. **Steps.** Numbered `##` sections. One command or one edit each. Real output pasted under each.
5. **What you have now.** The finished artifact, described in two sentences.
6. **Next.** One or two links, no more.

## Opening move

Open with the artifact the reader will hold at the end and the time it takes to get there, then move
straight to prerequisites.

## Exemplar paragraph

> Let's say you have a CSV of clinic addresses exported from three different systems, and the same clinic
> appears in it four times with four spellings. By the end of this tutorial you'll have a GeoJSON file with
> one point per clinic, ready to open in QGIS. `@mailwoman/registry` does it in three calls: `ingestRows`
> maps your columns onto normalized records, `resolveEntities` runs the block, score and cluster passes to
> group records that describe the same place, and `toGeoJSON` writes the FeatureCollection. About twenty
> minutes, most of it waiting on the geocode pass.

<!-- illustrative -->

```ts
import { ingestRows, resolveEntities, toGeoJSON } from "@mailwoman/registry"

const records = ingestRows(rows, {
	mapping: { name: "Provider Name", address: "Street Address", city: "City" },
})
const entities = await resolveEntities(records, { geocodeAddress })

await writeFile("clinics.geojson", JSON.stringify(toGeoJSON(entities)))
```

## Checks before commit

- Every command in the page was executed, and the pasted output is what it printed.
- Every constraint that can stop a reader is stated before the step it stops.
- Each caveat gives a ceiling and a next action in the same sentence pair.
- Every superlative is cashed out by a checkable action in the same breath, or it is cut.
- The audit checklist in [`../writing-system.md`](../writing-system.md) has been run over the draft.
