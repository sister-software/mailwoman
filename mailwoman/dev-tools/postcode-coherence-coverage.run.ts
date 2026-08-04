/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #42 coverage bound: for which countries can the postcode-country coherence pass see a postcode AT ALL, on a given
 *   backend? That bounds where default-on could ever matter, independently of how well the mechanism works.
 *
 *   Two things are measured, because one without the other misleads:
 *
 *   1. ROWS — `placetype = 'postalcode'` counts per country, read straight off the backend's own table. A count is not
 *      reachability (an indexed row the query path never returns is still zero evidence), so it is reported as a bound,
 *      not as coverage.
 *   2. REACHABILITY — one real (postcode, locality) pair per codex system, run through the same `findPlace` calls the
 *      pass itself makes, reporting whether the postcode resolved, whether an EXACT same-named locality came back, and
 *      whether the pair was therefore coherent. This is the number that decides whether the pass can speak.
 *
 *   The candidate SET is bounded by codex, not by the gazetteer: `candidateSystemsForPostcode` only knows eight systems,
 *   so a country with no codex slice can never be proposed however many rows it has. The probe therefore walks exactly
 *   those eight.
 *
 *   Run from the repo root: `node mailwoman/dev-tools/postcode-coherence-coverage.run.ts <fts|candidate>`
 */

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { candidateSystemsForPostcode } from "@mailwoman/codex"
import type { ResolverBackend } from "@mailwoman/core/resolver"
import { cliArguments } from "@mailwoman/core/scripting/utils"
import { dataRootPath, wofShardPaths } from "@mailwoman/core/utils"
import { findPostcodeCountryScope } from "@mailwoman/resolver"
import { WOFCandidateTableLookup, WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"

import { conventionCandidateDBPath } from "../resolver-backend.ts"

/**
 * One real pair per codex system — a postcode that exists and the locality it belongs to. The pass needs BOTH halves,
 * so a system whose postcodes are present but whose localities are not still reads as unreachable, which is correct:
 * the mechanism would abstain there.
 */
const PROBES: ReadonlyArray<{ system: string; country: string; postcode: string; locality: string }> = [
	{ system: "us", country: "US", postcode: "75001", locality: "Addison" },
	{ system: "de", country: "DE", postcode: "10117", locality: "Berlin" },
	{ system: "fr", country: "FR", postcode: "75001", locality: "Paris" },
	{ system: "ca", country: "CA", postcode: "M5V 3L9", locality: "Toronto" },
	{ system: "gb", country: "GB", postcode: "SW1A 2AA", locality: "London" },
	{ system: "jp", country: "JP", postcode: "100-0001", locality: "Chiyoda" },
	{ system: "au", country: "AU", postcode: "2000", locality: "Sydney" },
	{ system: "nz", country: "NZ", postcode: "6011", locality: "Wellington" },
]

const [backendName] = cliArguments()

if (backendName !== "fts" && backendName !== "candidate") {
	throw new Error("usage: postcode-coherence-coverage.run.ts <fts|candidate>")
}

const candidatePath = conventionCandidateDBPath()

const backend: ResolverBackend =
	backendName === "candidate"
		? new WOFCandidateTableLookup({ databasePath: candidatePath })
		: new WOFSqlitePlaceLookup({ databasePath: wofShardPaths().filter(existsSync) })

//#region 1. Row counts

const rows = new Map<string, number>()

if (backendName === "candidate") {
	const db = new DatabaseSync(candidatePath, { readOnly: true })

	for (const r of db
		.prepare(
			`SELECT cc.code AS country, COUNT(*) AS n
			 FROM candidate c
			 JOIN placetype_codes pc ON pc.id = c.placetype_id
			 JOIN country_codes cc ON cc.id = c.country_id
			 WHERE pc.placetype = 'postalcode'
			 GROUP BY cc.code`
		)
		.all() as { country: string; n: number }[]) {
		rows.set((r.country ?? "").toUpperCase(), r.n)
	}

	db.close()
} else {
	for (const path of wofShardPaths().filter(existsSync)) {
		const db = new DatabaseSync(path, { readOnly: true })

		for (const r of db
			.prepare("SELECT country, COUNT(*) AS n FROM spr WHERE placetype = 'postalcode' GROUP BY country")
			.all() as { country: string; n: number }[]) {
			const c = (r.country ?? "").toUpperCase()
			rows.set(c, (rows.get(c) ?? 0) + r.n)
		}

		db.close()
	}
}

//#endregion

//#region 2. Live reachability, through the pass's own lookups

console.log(
	`\n### ${backendName} backend · ${backendName === "fts" ? wofShardPaths().filter(existsSync).length : 1} source(s)`
)
console.log(`\n| system | country | postcode rows | postcode resolves | exact locality | pair coherent |`)
console.log(`| --- | --- | ---: | --- | --- | --- |`)

for (const probe of PROBES) {
	const postcodeHits = await backend.findPlace({
		text: probe.postcode,
		placetype: "postalcode",
		country: probe.country,
		limit: 3,
	})

	const localityHits = await backend.findPlace({
		text: probe.locality,
		placetype: "locality",
		country: probe.country,
		limit: 5,
	})

	const located = postcodeHits.find((p) => p.lat !== 0 || p.lon !== 0)
	const exact = localityHits.some((p) => p.exactMatch && (p.lat !== 0 || p.lon !== 0))

	// The verdict the pass itself would reach, via the impossible-default probe (step 1 always fails, so the
	// alternatives alone decide) — the one number that says whether this country is REACHABLE evidence.
	const scope = await findPostcodeCountryScope(
		[
			{ tag: "postcode", value: probe.postcode, start: 0, end: probe.postcode.length, confidence: 0.95, children: [] },
			{ tag: "locality", value: probe.locality, start: 0, end: probe.locality.length, confidence: 0.95, children: [] },
		],
		backend,
		{ postcode: probe.postcode, defaultCountry: "ZZ" }
	)

	console.log(
		`| ${probe.system} | ${probe.country} | ${rows.get(probe.country) ?? 0} | ${located ? "yes" : "**no**"} | ` +
			`${exact ? "yes" : "**no**"} | ${scope ? `yes → ${scope.country} @ ${scope.distanceKm.toFixed(1)} km` : "**no**"} |`
	)
}

console.log(
	`\ncodex systems (the only countries the pass can ever propose): ${candidateSystemsForPostcode("75001").length ? PROBES.map((p) => p.system).join(", ") : "?"}`
)
console.log(`data root: ${dataRootPath()}`)

//#endregion
