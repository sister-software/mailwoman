/**
 * Unit-designator ablation with the private-mailbox arm beside it: `#` reads
 * as a unit designator on a street address and as a private-mailbox leader,
 * so teaching one reading can be paid for with the other.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { haversineKm } from "@mailwoman/spatial"

import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: { "out-json": { type: "string" }, "weights-cache": { type: "string" } },
})

/**
 * 100 m is the loosest radius that still refuses the Athens label centroid, 1,627 m from this point.
 */
const ROOFTOP = { lat: 33.959694, lon: -83.3763072 } as const
const ROOFTOP_RADIUS_M = 100

const UNIT_ROWS: ReadonlyArray<{ input: string; expectUnit: string | null; note: string }> = [
	{ input: "301 College Ave, Athens, GA 30601", expectUnit: null, note: "control — no unit" },
	{ input: "301 College Ave #101, Athens, GA 30601", expectUnit: "#101", note: "the defect" },
	{ input: "301 College Ave Apt 101, Athens, GA 30601", expectUnit: "Apt 101", note: "word designator" },
	{ input: "301 College Ave Suite 101, Athens, GA 30601", expectUnit: "Suite 101", note: "word designator" },
	{ input: "301 College Ave Ste 101, Athens, GA 30601", expectUnit: "Ste 101", note: "word designator" },
	{ input: "301 College Ave Unit 101, Athens, GA 30601", expectUnit: "Unit 101", note: "word designator" },
	{ input: "301 College Ave # 101, Athens, GA 30601", expectUnit: "# 101", note: "spaced sigil" },
	{ input: "301 College Ave, #101, Athens, GA 30601", expectUnit: "#101", note: "comma-delimited sigil" },
	{ input: "301 College Ave, 101, Athens, GA 30601", expectUnit: "101", note: "bare identifier" },
]

/**
 * `PMB 123` must keep resolving to `po_box`, which a change that fixes `PMB #123` can break.
 */
const PMB_ROWS: ReadonlyArray<{ input: string; expectPOBox: string }> = [
	{ input: "PMB 123, 4400 Ashton Dr, Sarasota, FL 34233", expectPOBox: "PMB 123" },
	{ input: "PMB #123, 4400 Ashton Dr, Sarasota, FL 34233", expectPOBox: "PMB #123" },
]

const METRES_PER_KM = 1000

const deps = await buildGauntletDeps(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {})
const unitReport = []
const pmbReport = []

for (const row of UNIT_ROWS) {
	const result = await deps.geocode(row.input, { defaultCountry: "US" })

	const metres =
		result.lat == null || result.lon == null
			? null
			: haversineKm(result.lat, result.lon, ROOFTOP.lat, ROOFTOP.lon) * METRES_PER_KM

	unitReport.push({
		...row,
		street: result.street ?? null,
		unit: result.unit ?? null,
		tier: result.resolution_tier ?? null,
		metresFromRooftop: metres === null ? null : Math.round(metres),
		unitCorrect: (result.unit ?? null) === row.expectUnit,
		reachedRooftop: metres !== null && metres <= ROOFTOP_RADIUS_M,
	})
}

for (const row of PMB_ROWS) {
	const result = await deps.geocode(row.input, { defaultCountry: "US" })
	// `components`, not the flat projection: the result promotes a subset of tags
	// to top-level fields and `po_box` is not among them.
	const poBox = result.components?.po_box ?? null

	pmbReport.push({
		...row,
		po_box: poBox,
		street: result.components?.street ?? null,
		correct: poBox === row.expectPOBox,
	})
}

console.log(`#2298 unit ablation — ${unitReport.length} rows, one designator apart\n`)
console.log(`| input | street | unit | tier | m from rooftop |`)
console.log(`| --- | --- | --- | --- | --: |`)

for (const row of unitReport) {
	const distance = row.metresFromRooftop === null ? "—" : String(row.metresFromRooftop)

	console.log(
		`| ${row.input} | ${stringifyJSON(row.street)} | ${stringifyJSON(row.unit)} | ${row.tier ?? "—"} | ${distance} |`
	)
}

const reached = unitReport.filter((row) => row.reachedRooftop)
const tagged = unitReport.filter((row) => row.unitCorrect)

console.log(
	`\n${reached.length}/${unitReport.length} reach the rooftop; ${tagged.length}/${unitReport.length} tag the unit as written.`
)
console.log(`\nprivate-mailbox arm — the reading a unit gain can be paid for with\n`)
console.log(`| input | po_box | street |`)
console.log(`| --- | --- | --- |`)

for (const row of pmbReport) {
	console.log(`| ${row.input} | ${stringifyJSON(row.po_box)} | ${stringifyJSON(row.street)} |`)
}

console.log(`\n${pmbReport.filter((row) => row.correct).length}/${pmbReport.length} keep the private mailbox.`)

if (values["out-json"]) {
	await writeLocalJSONFile({ units: unitReport, privateMailbox: pmbReport }, values["out-json"])

	console.log(`\nwrote ${values["out-json"]}`)
}
