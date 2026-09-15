/**
 * The four surfaces #2303 is decided on, over the same US cities, through the production path.
 *
 * `Washington, DC 20003` answers a locality far less often than `123 Main St, Washington, DC 20003` does, and the
 * corpus reason is that no US recipe ever put a city in front of a state code and a ZIP without a street ahead of it.
 * This renders one set of real cities four ways and reports the locality-match rate of each, so the three-arm table on
 * the issue and the REVERSE risk are one measurement rather than two.
 *
 * The reverse arm is the half a three-arm table cannot show. Teaching `«city», «ST» «ZIP»` risks the inverse — a
 * genuine street before a state code read as a locality — and the only way to see it is to ask for a street in that
 * exact position and count how often it comes back tagged `locality`. A row whose locality is null there is CORRECT.
 *
 * The panel is derived from the US coordinate set, one row per distinct city, and the street arm reuses that row's own
 * street so no arm invents an address that does not exist.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/us/city-state-postcode-arms.run.ts
 *     node packages/mailwoman/lib/dev-tools/us/city-state-postcode-arms.run.ts --out-json <path>
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import { JSONSpliterator } from "spliterator"

import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		"weights-cache": { type: "string" },
		eval: { type: "string", default: String(dataRootPath("eval", "coord", "us.jsonl")) },
		limit: { type: "string" },
	},
})

interface CoordRow {
	input: string
	expected?: { locality?: string; region?: string; postcode?: string }
}

/**
 * The street of a coordinate row, with its house number removed.
 *
 * The reverse arm needs a street that stands where a city would, and a house number in front of it is the very cue that
 * makes the shape unambiguous — leaving it in would measure the arm that already works.
 */
function streetWithoutNumber(input: string): string | undefined {
	const head = input.split(",")[0]?.trim()

	if (!head) return undefined

	const rest = head.replace(/^\d+[A-Za-z]?\s+/, "").trim()

	return rest && rest !== head ? rest : undefined
}

const rows = await Array.fromAsync(JSONSpliterator.fromAsync<CoordRow>(values.eval!))
const byCity = new Map<string, { locality: string; region: string; postcode: string; street: string }>()

for (const row of rows) {
	const locality = row.expected?.locality?.trim()
	const region = row.expected?.region?.trim()
	const postcode = row.expected?.postcode?.trim()
	const street = streetWithoutNumber(row.input)

	if (!locality || !region || !postcode || !street || byCity.has(locality)) continue

	byCity.set(locality, { locality, region, postcode, street })
}

const panel = values.limit ? [...byCity.values()].slice(0, Number(values.limit)) : [...byCity.values()]

/**
 * One panel city — the four surfaces below are four ways of writing it.
 */
type City = (typeof panel)[number]

/**
 * The four surfaces, and what a correct answer looks like in each.
 *
 * `street_only` is the reverse arm and is graded INVERTED: the street must not be read as a locality, so a row with no
 * locality at all is the pass.
 */
const ARMS = [
	{ name: "bare", inverted: false, render: (c: City) => `${c.locality}, ${c.region} ${c.postcode}` },
	{ name: "with_country", inverted: false, render: (c: City) => `${c.locality}, ${c.region} ${c.postcode}, USA` },
	{
		name: "with_street",
		inverted: false,
		render: (c: City) => `123 Main St, ${c.locality}, ${c.region} ${c.postcode}`,
	},
	{ name: "street_only", inverted: true, render: (c: City) => `${c.street}, ${c.region} ${c.postcode}` },
] as const

/**
 * Misses printed per arm. Enough to read what the wrong answers look like; the rate above them is the measurement.
 */
const EXAMPLES_PER_ARM = 5

// A probe written to price a corpus change has to be able to point at the model that change produced; without this it
// can only ever grade the installed one, which is the arm the change is measured AGAINST.
const deps = await buildGauntletDeps(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {})
const report: Record<string, { matched: number; noLocality: number; total: number; examples: string[] }> = {}

for (const arm of ARMS) {
	let matched = 0
	let noLocality = 0
	const examples: string[] = []

	for (const city of panel) {
		const input = arm.render(city)
		const result = await deps.geocode(input, { defaultCountry: "US" })
		const locality = result.locality ?? null

		if (locality === null) {
			noLocality++
		}

		if (locality === city.locality) {
			matched++
		}

		// What counts as a failure differs by arm, so the examples have to ask the arm. `street_only` is graded
		// inverted, and listing rows whose locality is not the city's would print its PASSES under a "misses" heading —
		// every one of them `null`, which is the answer that arm wants.
		const failed = arm.inverted ? locality !== null : locality !== city.locality

		if (failed && examples.length < EXAMPLES_PER_ARM) {
			examples.push(`${input} → locality ${stringifyJSON(locality)} (city ${stringifyJSON(city.locality)})`)
		}
	}

	report[arm.name] = { matched, noLocality, total: panel.length, examples }
}

console.log(`#2303 arms — ${panel.length} distinct US cities, production path\n`)
console.log(`| arm | locality matched | no locality at all |`)
console.log(`| --- | --: | --: |`)

for (const arm of ARMS) {
	const r = report[arm.name]!

	console.log(`| ${arm.name} | ${formatPercent(r.matched, r.total)} (${r.matched}/${r.total}) | ${r.noLocality} |`)
}

console.log(
	`\nThe reverse arm is graded inverted: \`street_only\` wants NO locality, so its "no locality at all" column is` +
		` the pass count — ${report["street_only"]!.noLocality}/${panel.length}.`
)

for (const arm of ARMS) {
	const r = report[arm.name]!

	if (r.examples.length) {
		console.log(`\n${arm.name} misses:\n  ${r.examples.join("\n  ")}`)
	}
}

if (values["out-json"]) {
	await writeLocalJSONFile({ panel: panel.length, arms: report }, values["out-json"])

	console.log(`\nwrote ${values["out-json"]}`)
}
