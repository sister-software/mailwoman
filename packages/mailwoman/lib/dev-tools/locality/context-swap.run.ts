/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does a locality resolve differently because of its name, or because of the admin context around it? (#2311)
 *
 *   The bare admin surface reads 100.0% in Vermont and 2.3% in Arkansas over a region-stratified panel, a 97.7-point
 *   spread. `Greensboro Bend, VT 05842` and `Horseshoe Bend, AR 72512` share a tail word and a shape. one answers a
 *   locality and the other answers none.
 *
 *   This holds the locality fixed and varies what stands beside it. Two modes:
 *
 *   `--mode swap` re-renders each subject under every host region. `--mode grid` runs the 2x2 that separates the two
 *   things a swap moves together: home region with home postcode, home region with the donor's postcode, the donor's
 *   region with the home postcode, and both. Measured on the v5.7.0 candidate over 60 Arkansas localities that fail at
 *   home: 0/60, 36/60, 30/60, 58/60.
 *
 *   Postcodes are real codes drawn from the panel, but a crossed pairing denotes no place. No coordinate is claimed
 *   for it, and the grade is only whether the locality the row was given came back. The result is therefore about what
 *   the decode conditions on rather than about the world.
 *
 *   The arms geocode in place rather than through a written panel. `readCoordPanel` keys on (country, region,
 *   locality), and the grid's arms differ only in the postcode, so routing them through a panel file collapses each
 *   pair of arms into one row. Reading the panel once and rendering each arm from the same rows avoids the key.
 *
 *   Usage:
 *
 *       node packages/mailwoman/lib/dev-tools/locality/context-swap.run.ts --mode swap --weights-cache <dir>
 *       node packages/mailwoman/lib/dev-tools/locality/context-swap.run.ts --mode grid --home AR --donor VT
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"

import { readCoordPanel, renderAdmin } from "#dev-tools/coord-panel"
import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"weights-cache": { type: "string" },
		eval: { type: "string", default: String(dataRootPath("eval", "coord", "us.jsonl")) },
		mode: { type: "string", default: "swap", choices: ["swap", "grid"] },
		/**
		 * Regions whose localities are the subjects — the ones whose behaviour is in question.
		 */
		home: { type: "string", default: "AR,TN,MO,TX" },
		/**
		 * Regions the subjects are re-rendered under.
		 */
		donor: { type: "string", default: "VT,NH,ME,MA" },
		subjects: { type: "string", default: "60" },
		country: { type: "string", default: "US" },
	},
})

const homeRegions = values.home!.split(",")
const donorRegions = values.donor!.split(",")
const subjectCount = Number(values.subjects)

const { localities } = await readCoordPanel(values.eval!, { country: values.country })

/**
 * One real postcode per region, so a crossed row carries a code that exists even
 * though its pairing does not.
 */
const postcodeOf = new Map<string, string>()

for (const place of localities) {
	if (!postcodeOf.has(place.region)) {
		postcodeOf.set(place.region, place.postcode)
	}
}

const regionsPresent = new Set(localities.map((place) => place.region))

/**
 * The panel's rows for one region, raising when the panel holds none.
 *
 * An absent region yields an empty arm, which reports 0% and is indistinguishable from a measured zero.
 * The default coordinate panel's 2,000 rows carry 7 of the 50 states and DC
 * (CA, DC, IL, SD, MT, IA, VT), so most regions hit this path.
 */
function byRegion(region: string): typeof localities {
	if (!regionsPresent.has(region)) {
		throw new Error(
			`${values.eval} holds no ${region} rows — it carries ${regionsPresent.size} region(s): ` +
				`${[...regionsPresent].toSorted().join(", ")}. Pass --eval with a panel that covers ${region}.`
		)
	}

	return localities.filter((place) => place.region === region)
}

/**
 * One arm: a name, the region and postcode it is being written under, and which arm it belongs to.
 */
interface Arm {
	name: string
	rows: Array<{ locality: string; region: string; postcode: string }>
}

function swapArms(): Arm[] {
	const subjects = homeRegions.flatMap((region) => byRegion(region).slice(0, subjectCount))

	return donorRegions.map((host) => ({
		name: `subject in ${host}`,
		rows: subjects.map((place) => ({
			locality: place.locality,
			region: host,
			postcode: postcodeOf.get(host)!,
		})),
	}))
}

function gridArms(): Arm[] {
	const home = homeRegions[0]!
	const donor = donorRegions[0]!
	const subjects = byRegion(home).slice(0, subjectCount)

	return (
		[
			[`control — ${home} region, ${home} postcode`, home, home],
			[`${home} region, ${donor} postcode`, home, donor],
			[`${donor} region, ${home} postcode`, donor, home],
			[`${donor} region, ${donor} postcode`, donor, donor],
		] as const
	).map(([name, region, postcodeFrom]) => ({
		name,
		rows: subjects.map((place) => ({
			locality: place.locality,
			region,
			postcode: postcodeOf.get(postcodeFrom)!,
		})),
	}))
}

const arms = values.mode === "grid" ? gridArms() : swapArms()
const deps = await buildGauntletDeps(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {})

console.log(`#2311 context swap — mode ${values.mode}, ${arms.length} arm(s), v5.7.0 path\n`)
console.log(`| arm | rows | locality recovered |`)
console.log(`| --- | --: | --: |`)

/**
 * How many recovered rows to print under the table.
 *
 * The list shows what the arms render. the table carries the rate.
 */
const RESCUED_EXAMPLES = 8

const rescued: string[] = []

for (const [index, arm] of arms.entries()) {
	let matched = 0

	for (const row of arm.rows) {
		const input = renderAdmin({ ...row, country: values.country!, lat: 0, lon: 0, input: "" })
		const result = await deps.geocode(input, { defaultCountry: values.country! })

		if ((result.locality ?? null) !== row.locality) continue

		matched++

		if (rescued.length < RESCUED_EXAMPLES && index > 0) {
			rescued.push(`  RECOVERED  ${input}`)
		}
	}

	console.log(`| ${arm.name} | ${arm.rows.length} | ${formatPercent(matched, arm.rows.length)} (${matched}) |`)
}

console.log("")

for (const line of rescued) {
	console.log(line)
}
