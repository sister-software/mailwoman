#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #823/#742 COVERAGE EXPANSION — fold GeoNames cities15000 into the candidate gazetteer for the
 *   countries that currently have ZERO candidate rows. The 2026-06-26 frontier diagnostic framed the
 *   non-US gap as an exonym/alt-name problem, but the #826 kill-switch probe
 *   (`scripts/eval/frontier-existence.ts`) measured exonym-only reliance at ~1% — the alt-name fold is
 *   already shipped (the 2026-06-27 build indexes the full GeoNames `alternatenames` set as name_key
 *   rows). The real gap is COUNTRY-LEVEL absence: ~147 non-US countries (Albania, Armenia, Georgia,
 *   Bosnia, Kosovo, Hong Kong, + much of Africa / Central Asia) have no rows in the population-first
 *   candidate table the demo / drop-ins use. The #742 gap-fill lived in a side-index, never folded here.
 *
 *   This reuses the SHIPPED pipeline verbatim — `foldGeonamesIntoAdmin` (which calls
 *   `ingestGeonamesAliases` + rebuilds `place_search`) then `buildCandidate`. The only new step is
 *   feeding cities15000-derived `<CC>.txt` for the zero-row countries: cities15000 has the identical
 *   GeoNames dump column layout, so we split it by country into a scratchpad merge dir (the canonical
 *   `<data-root>/geonames` is never touched) and point the fold there alongside the real EU dumps the
 *   DEFAULT fold needs. Build-on-copy: writes a STAGED admin + STAGED candidate; the canonical symlink
 *   is only repointed by `mailwoman gazetteer promote` after the gate passes. US is left untouched.
 *
 *   Full per-country GeoNames dumps (village-level) are a follow-up; cities15000 (pop ≥ 15k) closes the
 *   "capital / major city resolves nowhere" gap the frontier measures.
 *
 *   Run: node scripts/build-coverage-expansion.ts [--admin <in.db>] [--out <staged-candidate.db>]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
	buildCandidate,
	DEFAULT_FOLD_COUNTRIES,
	foldGeonamesIntoAdmin,
	geonamesDir,
	resolvePostcodeShards,
	wofDir,
} from "../mailwoman/out/gazetteer-pipeline.js"
import { arg } from "./lib/cli-args.ts"

const WOF = wofDir()
const GN = geonamesDir()
const CITIES = join(GN, "cities15000.txt")
const SCRATCH = "/tmp/claude-1000/-home-lab-Projects-mailwoman/c80f7323-3457-405d-8fff-97ee295aede2/scratchpad"

const ADMIN_IN = arg("admin", join(WOF, "admin-global-priority.db"))
const CANON_CAND = arg("canonical", join(WOF, "candidate.db"))
const STAGED_ADMIN = arg("admin-out", join(WOF, "admin-global-priority-coverage.db"))
const STAGED_CAND = arg("out", join(WOF, "candidate-global-coverage.db"))
const MERGE = arg("geonames-merge", join(SCRATCH, "geonames-merge"))

if (!existsSync(CITIES)) {
	console.error(`cities15000 not found: ${CITIES}`)
	process.exit(1)
}

if (!existsSync(CANON_CAND)) {
	console.error(`canonical candidate DB not found: ${CANON_CAND}`)
	process.exit(1)
}

// 1. Countries already covered (≥1 row) in the canonical candidate table.
const cdb = new DatabaseSync(CANON_CAND, { readOnly: true })
const covered = new Set<string>(
	(
		cdb
			.prepare("SELECT DISTINCT cc.code AS code FROM candidate cand JOIN country_codes cc ON cand.country_id = cc.id")
			.all() as Array<{ code: string }>
	).map((r) => r.code)
)
cdb.close()

// 2. cities15000 grouped by country (non-US). Lines kept verbatim — the GeoNames dump column layout is
//    identical, so the existing ingest reads them unchanged.
const byCountry = new Map<string, string[]>()

for (const line of readFileSync(CITIES, "utf8").split("\n")) {
	if (!line) continue
	const cc = line.split("\t")[8]

	if (!cc || cc === "US") continue
	const arr = byCountry.get(cc) ?? []
	arr.push(line)
	byCountry.set(cc, arr)
}
const targets = [...byCountry.keys()].filter((cc) => !covered.has(cc)).sort()
console.error(`[coverage] ${targets.length} zero-row target countries; ${covered.size} already covered`)
console.error(`[coverage] targets: ${targets.join(" ")}`)

// 3. Build the merge GeoNames dir: REAL EU dumps (symlinked, full coverage) + cities15000-synthesized
//    `<CC>.txt` for the zero-row targets. The canonical geonames dir is never written.
rmSync(MERGE, { recursive: true, force: true })
mkdirSync(MERGE, { recursive: true })

for (const cc of DEFAULT_FOLD_COUNTRIES) {
	const src = join(GN, `${cc}.txt`)

	if (existsSync(src)) symlinkSync(src, join(MERGE, `${cc}.txt`))
}
let synthCities = 0

for (const cc of targets) {
	const lines = byCountry.get(cc)!
	writeFileSync(join(MERGE, `${cc}.txt`), `${lines.join("\n")}\n`)
	synthCities += lines.length
}
console.error(`[coverage] synthesized ${synthCities} cities across ${targets.length} <CC>.txt files in ${MERGE}`)

// 4. Durable GeoNames fold (build-on-copy) — DEFAULT EU set (real dumps) + the targets, one id sequence.
const countries = [...new Set([...DEFAULT_FOLD_COUNTRIES, ...targets])]
console.error(`[fold] ${countries.length} countries → ${STAGED_ADMIN}`)
const fold = await foldGeonamesIntoAdmin({
	adminIn: ADMIN_IN,
	adminOut: STAGED_ADMIN,
	countries,
	geonamesDir: MERGE,
	onCountry: (e) => {
		if (!e.skipped && e.places > 0) process.stderr.write(`\r[fold] ${e.country}: ${e.places}      `)
	},
	onPhase: (p, d) => console.error(`\n[fold:${p}]${d ? ` ${d}` : ""}`),
})
console.error(
	`\n[fold] ingested ${fold.ingested.toLocaleString()} places; place_search ${fold.placeSearchRows.toLocaleString()} rows`
)

// 5. Candidate build from the folded admin + the canonical postcode shards.
console.error(`[cand] building ${STAGED_CAND}`)
const r = await buildCandidate({
	adminDb: STAGED_ADMIN,
	out: STAGED_CAND,
	postcodeShards: resolvePostcodeShards(),
	onProgress: (phase, msg) => console.error(`[cand:${phase}] ${msg}`),
})

console.log(`\n✓ staged candidate: ${STAGED_CAND}`)
console.log(
	`  ${r.rows.toLocaleString()} rows — ${r.primaries.toLocaleString()} primary, ${r.aliases.toLocaleString()} alias, ${r.postcodes.toLocaleString()} postcode (from ${r.places.toLocaleString()} places)`
)
console.log(`  +${targets.length} previously-zero-coverage countries`)
