/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pairs two county coverage censuses by FIPS code and lists the counties whose thin status moved.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/us/address-coverage/census-compare.run.ts --before <census.json>
 *   --after <census.json> [--state <two-digit FIPS>]
 *
 *   Both files are `census.run.ts` outputs. A county is thin when its points fall under
 *   {@linkcode THIN_COUNTY_RATIO} of its estimated structures. A county present in one census only is listed by itself,
 *   because the two runs then read different denominators.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { type CountyCoverage, coverageRatio, THIN_COUNTY_RATIO } from "#tools/dev-tools/us/address-coverage/census"

const { values } = parseArguments({
	options: { before: { type: "string" }, after: { type: "string" }, state: { type: "string" } },
})

if (!values.before || !values.after) throw new Error("--before and --after are required")

/**
 * The two-digit FIPS prefix of the state whose thin counties `--state` lists, from the after census.
 */
const statePrefix = values.state

const read = async (path: string) => {
	const { counties } = await readLocalJSONFile<{ counties: CountyCoverage[] }>(path)

	return new Map(counties.map((county) => [county.fips, county]))
}

const before = await read(values.before)
const after = await read(values.after)
const thin = (county: CountyCoverage) => (coverageRatio(county) ?? 1) < THIN_COUNTY_RATIO

const describe = (county: CountyCoverage) =>
	`${county.fips}\t${county.name}\t${county.addressPoints} points / ${Math.round(county.structures)} structures` +
	`\t${coverageRatio(county)?.toFixed(3)}`

const left: string[] = []
const joined: string[] = []
const unpaired: string[] = []

for (const [fips, previous] of before) {
	const current = after.get(fips)

	if (!current) {
		unpaired.push(`before only\t${describe(previous)}`)

		continue
	}

	if (thin(previous) && !thin(current)) {
		left.push(`${describe(previous)}\t→ ${coverageRatio(current)?.toFixed(3)}`)
	}

	if (!thin(previous) && thin(current)) {
		joined.push(`${describe(current)}\t← ${coverageRatio(previous)?.toFixed(3)}`)
	}
}

for (const [fips, current] of after) {
	if (!before.has(fips)) {
		unpaired.push(`after only\t${describe(current)}`)
	}
}

console.log(`left the thin list: ${left.length}`)

for (const line of left) {
	console.log(`  ${line}`)
}

console.log(`joined the thin list: ${joined.length}`)

for (const line of joined) {
	console.log(`  ${line}`)
}

console.log(`in one census only: ${unpaired.length}`)

for (const line of unpaired) {
	console.log(`  ${line}`)
}

if (statePrefix) {
	const stateThin = [...after.values()].filter((county) => county.fips.startsWith(statePrefix) && thin(county))

	console.log(`thin in state ${statePrefix} after: ${stateThin.length}`)

	for (const county of stateThin.toSorted((a, b) => (coverageRatio(a) ?? 0) - (coverageRatio(b) ?? 0))) {
		console.log(`  ${describe(county)}`)
	}
}
