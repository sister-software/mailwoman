/**
 * The unit-designator ablation #2298 is decided on, with the private-mailbox arm beside it.
 *
 * One token isolates the defect: `301 College Ave Apt 101, Athens, GA 30601` reaches
 * the rooftop and `301 College Ave #101, Athens, GA 30601` answers a city centroid,
 * because the word designators are attested and the bare `#` is not.
 * The rows below hold everything else constant and vary only the designator.
 *
 * The private-mailbox ARM is not decoration.
 * `#` reads as a unit designator on a street address and as a private-mailbox leader
 * in `synthesizers/po-box.ts` — `US_PMB_LEADERS` excludes it for exactly that reason —
 * so teaching one reading can be paid for with the other.
 *
 * A run that reports the unit rows recovering and makes no statement about
 * `PMB 123` has measured half of the change.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/us/unit-ablation.run.ts
 *     node packages/mailwoman/lib/dev-tools/us/unit-ablation.run.ts --out-json <path>
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
 * The rooftop `301 College Ave` resolves to, and the radius a row has to land
 * inside to count as having reached it.
 *
 * Both from #2298: the address point is 33.959694 / -83.3763072, and the failing
 * rows answer the Athens label centroid 1,627 m away, so any bound between the two
 * separates them. 100 m is the loosest that still refuses the centroid.
 */
const ROOFTOP = { lat: 33.959694, lon: -83.3763072 } as const
const ROOFTOP_RADIUS_M = 100

/**
 * The six ablation rows, plus the three the issue's prose names as ruling out tokenization.
 *
 * `expectUnit` is what the row's designator should land in.
 * Null means the row carries no unit at all, which is the control.
 *
 * It is the same address without one, and it is what proves the rooftop is reachable.
 */
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
 * The private-mailbox arm.
 *
 * `PMB 123` answers `po_box` today and must keep it; `PMB #123` does not, and is here
 * so a change that fixes it is visible rather than silent.
 */
const PMB_ROWS: ReadonlyArray<{ input: string; expectPOBox: string }> = [
	{ input: "PMB 123, 4400 Ashton Dr, Sarasota, FL 34233", expectPOBox: "PMB 123" },
	{ input: "PMB #123, 4400 Ashton Dr, Sarasota, FL 34233", expectPOBox: "PMB #123" },
]

const METRES_PER_KM = 1000

// A probe written to price a corpus change has to be able to point at the model that change produced.
// Without this it can only ever grade the installed one, which is the arm the change is measured against.
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
	// `components`, not the flat projection: the result promotes a subset of tags to top-level fields
	// and `po_box` is not among them, so `result.po_box` is undefined on a row that carries one.
	// Reading it there reported 0 of 2 private mailboxes lost when both were intact.
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
