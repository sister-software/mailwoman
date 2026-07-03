#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #743/#193 — the DURABLE upstream GeoNames-alias fold. Folds GeoNames bilingual / alt-language
 *   place-names into a COPY of the admin (unified-WOF) DB's CANONICAL tables (`spr` / `names` /
 *   `place_population`), then rebuilds `place_search` + `place_bbox` from them — so the standard
 *   `build-candidate-cli` carries `Karjaa`↔`Karis` natively, with NO candidate-table patching.
 *
 *   This supersedes the candidate-side stopgap (`build-candidate-geonames-aliases.ts`), which
 *   inserted alt-names straight into a built candidate.db on a copy to MEASURE the resolve-rate
 *   lift before committing. The lift is proven (FI hard-resolve 69.5 → 85.8 %, coverage 74.4 → 94.0
 *   %); the durable home is upstream, in the admin artifact's `names`, so the candidate is a pure
 *   function of the admin DB again. From here the recipe is one clean `build-candidate-cli` run.
 *
 *   It reuses the CANONICAL `ingestGeonamesAliases` (the very function a full `build-unified-wof
 *   --geonames-countries` runs) + `buildPlaceSearchFTS`, so the folded admin DB is identical to a
 *   from-scratch unified build with `--geonames-countries` — but WITHOUT re-ingesting the global
 *   WOF GeoJSON repos (the full set isn't cloned locally). Build-on-copy, never in place: the
 *   canonical admin DB is opened read-only via the copy and is never mutated.
 *
 *   Usage: node --experimental-strip-types scripts/build-admin-geonames-fold.ts\
 *   --in /mnt/playpen/mailwoman-data/wof/admin-global-priority.db\
 *   --out /mnt/playpen/mailwoman-data/wof/admin-global-priority-geonames.db\
 *   --countries FI,PL,NO,CZ,AT,LT,LV,SI,SK,HR,DK,BE,CH,LU [--geonames-dir <dir>]
 *
 *   Then build the candidate gazetteer (FTS5-trigram fuzzy baked in by build-candidate) from the
 *   folded admin DB: node resolver-wof-sqlite/out/build-candidate-cli.js --in <out> --postcodes
 *   <...> --out candidate-global-<v>.db
 */
import { dataRootPath } from "@mailwoman/core/utils"
import { buildPlaceSearchFTS, ingestGeonamesAliases } from "@mailwoman/resolver-wof-sqlite"

const { values: a } = parseArgs({
	options: {
		in: { type: "string", default: "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db" },
		out: { type: "string", default: "/mnt/playpen/mailwoman-data/wof/admin-global-priority-geonames.db" },
		// The bilingual / alt-name EU set the stopgap proved the lift on. GeoNames `<CC>.txt` dumps from
		// download.geonames.org/export/dump must be present under --geonames-dir.
		countries: { type: "string", default: "FI,PL,NO,CZ,AT,LT,LV,SI,SK,HR,DK,BE,CH,LU" },
		"geonames-dir": { type: "string", default: "/mnt/playpen/mailwoman-data/geonames" },
		// #936: alternateNamesV2 dumps (language tags + the `official` bit). Missing files fold untagged.
		"geonames-alternate-dir": { type: "string", default: String(dataRootPath("geonames-alternate")) },
	},
})

const input = a.in!
const output = a.out!
const geonamesDir = a["geonames-dir"]!
const geonamesAlternateDir = a["geonames-alternate-dir"]!
const countries = a
	.countries!.split(",")
	.map((c) => c.trim().toUpperCase())
	.filter(Boolean)

if (!existsSync(input)) {
	console.error(`input admin DB missing: ${input}`)
	process.exit(1)
}

if (input === output) {
	console.error("refusing to write over the input — pick a distinct --out (build-on-copy, never in place)")
	process.exit(1)
}

console.error(`GeoNames upstream fold → ${output}`)
console.error(`  source (read via copy, never mutated): ${input}`)
console.error(`  countries: ${countries.join(",")}`)
const t0 = Date.now()

// Build on a copy: the canonical admin DB is never touched.
copyFileSync(input, output)
const db = new DatabaseSync(output)

const ingested = ingestGeonamesAliases(db, countries, geonamesDir, undefined, {
	alternateDir: geonamesAlternateDir,
})
console.error(
	`  ingested ${ingested.toLocaleString()} GeoNames places (+ Latin alt-names) → spr/names/place_population`
)

// Rebuild place_search (FTS5 alias bag) + place_bbox (R*Tree) from the updated spr/names so the new
// GeoNames rows are reachable by the candidate build's alias-explosion pass. drop:true forces a full
// rebuild against the new snapshot (the copy already carries both tables).
console.error("  rebuilding place_search + place_bbox from the updated names…")
const res = buildPlaceSearchFTS(db, {
	drop: true,
	onProgress: (phase, detail) => console.error(`    [${phase}]${detail ? ` ${detail}` : ""}`),
})
console.error(
	`  place_search: ${res.indexedRows.toLocaleString()} rows, place_bbox: ${res.bboxIndexedRows.toLocaleString()} rows (${(res.durationMs / 1000).toFixed(1)}s)`
)

db.exec("ANALYZE")
db.close()

const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.error(`\ndone in ${secs}s → ${output}`)
console.error("next: build-candidate-cli --in <out> --postcodes <...> --out candidate-global-<v>.db (FTS baked in)")
