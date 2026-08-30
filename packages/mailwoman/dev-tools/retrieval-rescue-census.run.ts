/**
 * Report-only retrieval-rescue census over the committed Gauntlet corpus (#1878). Not a release gate.
 *
 * One production-routed board pass with the shipped model. For each row: the delivered answer, the unconditional
 * fork-entity probe (gate 1 deliberately ignored — that is the measurement), and the resolver's ranked alternates,
 * classified against the row's coordinate truth by `retrieval-rescue-census.ts`.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { parseArgs } from "@mailwoman/platform/util"

import { loadRegressionCases } from "../eval-harness/gauntlet/cases/load.ts"
import { buildGauntletDeps } from "../eval-harness/gauntlet/harness.ts"
import { routeCountry } from "../eval-harness/gauntlet/routing.ts"
import { classifyRescueRow, type RescueRowReport, summarizeRescue } from "../eval-harness/retrieval-rescue-census.ts"
import { probeForkEntity } from "../fork-entity.ts"
import { loadForkEntityDeps } from "../geocode-session.ts"

const { values } = parseArgs({ options: { "out-json": { type: "string" } } })

const cases = await loadRegressionCases()
const deps = await buildGauntletDeps()
const probe = await loadForkEntityDeps({ dataRoot: String(mailwomanDataRoot()), forkEntity: true })

if (!probe.deps.poiLookup) {
	// The census's entity half is the point; a run without poi.db would silently degrade every
	// rescue_available_entity row into no_rescue_on_hand — the partial-reader rule says fail instead.
	throw new Error("retrieval-rescue census requires poi.db (loadForkEntityDeps returned no lookup)")
}

const reports: RescueRowReport[] = []

for (const c of cases) {
	const overlayCountry = routeCountry(c)

	// The board runner's own opts recipe (regression.ts) — the census must ride the production route.
	const result = await deps.geocode(c.input, {
		...(c.defaultCountry ? { defaultCountry: c.defaultCountry } : {}),
		...(overlayCountry ? { caseCountry: overlayCountry } : {}),
		...(c.locale ? { fuzzyCountryScope: c.locale.split("-")[1] } : {}),
	})

	const markers = result.intent_markers.map((m) => m.code)

	// Unconditional: ask the entity layer whenever the fork marker rode, INCLUDING when the incumbent
	// resolved — measuring what gate 1 currently silences is the census's purpose.
	const hit =
		markers.includes("declared_fork") && probe.deps.poiLookup && probe.deps.isStreetGeneric
			? probeForkEntity(c.input, {
					lookup: probe.deps.poiLookup,
					isStreetGeneric: probe.deps.isStreetGeneric,
				})
			: null

	const graded = classifyRescueRow({
		...(c.expectLat === undefined ? {} : { expectLat: c.expectLat }),
		...(c.expectLon === undefined ? {} : { expectLon: c.expectLon }),
		...(c.expectToleranceM === undefined ? {} : { expectToleranceM: c.expectToleranceM }),
		lat: result.lat,
		lon: result.lon,
		entityFired: result.entity !== undefined,
		...(hit ? { unconditionalEntityHit: { lat: hit.latitude, lon: hit.longitude } } : {}),
		alternateCandidates: result.candidates.slice(1).map((cand) => ({ lat: cand.lat, lon: cand.lon })),
	})

	reports.push({
		id: c.id,
		input: c.input,
		...(c.country ? { country: c.country } : {}),
		markers,
		classification: graded.classification,
		...(graded.deliveredKm === undefined ? {} : { deliveredKm: Number(graded.deliveredKm.toFixed(3)) }),
		...(graded.rescueRank === undefined ? {} : { rescueRank: graded.rescueRank }),
		gateProtects: graded.gateProtects,
	})
}

probe.handle?.[Symbol.dispose]()
deps[Symbol.dispose]()

const summary = summarizeRescue(reports)

console.log("=== retrieval-rescue census ===")
console.log(JSON.stringify(summary, null, 2))

for (const cls of ["rescue_available_entity", "rescue_available_rank", "rescue_available_both"] as const) {
	const rows = reports.filter((r) => r.classification === cls)

	if (!rows.length) continue

	console.log(`\n${cls}:`)

	for (const r of rows) {
		console.log(
			`  ${r.id}  "${r.input}"${r.rescueRank ? `  rank ${r.rescueRank}` : ""}  delivered ${r.deliveredKm ?? "∅"} km off`
		)
	}
}

const gateRows = reports.filter((r) => r.gateProtects)

if (gateRows.length) {
	console.log("\ngate_protects (correct today, at risk under a loosened gate):")

	for (const r of gateRows) {
		console.log(`  ${r.id}  "${r.input}"`)
	}
}

if (values["out-json"]) {
	await writeLocalJSONFile({ summary, rows: reports }, values["out-json"])

	console.log(`\nwrote ${values["out-json"]}`)
}
