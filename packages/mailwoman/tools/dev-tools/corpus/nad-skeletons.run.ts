/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the National Address Database skeletons the OA-skeleton recipes read: one OpenAddresses-layout
 *   zipped CSV per state in `NAD_SKELETON_STATES`, sampled uniformly and capped so no state dominates, and the
 *   ZIP-to-city tables for the `intersection` recipe's TIGER counties. It prints every state's address-shape
 *   measures. The table determines the state choice.
 *
 *   Usage:
 *   node --max-old-space-size=8192 packages/mailwoman/tools/dev-tools/corpus/nad-skeletons.run.ts \
 *     [--input <featureserver dir>] [--states IL,MA] [--cap 100000] [--seed 20261017]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	NAD_SKELETON_DIRECTORY,
	NAD_SKELETON_STATES,
	NAD_ZIP_CITY_COUNTIES,
} from "@mailwoman/corpus/us/recipes/skeleton-sources"
import { buildNADSkeletons, writeNADSkeletonSummary } from "@mailwoman/corpus/us/tools/nad-skeletons"

const { values } = parseArguments({
	options: {
		input: { type: "string", description: "NAD FeatureServer NDJSON directory" },
		states: { type: "string", description: "Comma-separated states to sample (default: NAD_SKELETON_STATES)" },
		cap: { type: "string", description: "Most rows per state sample (default 100000)" },
		seed: { type: "string", description: "Reservoir seed (default 20261017)" },
	},
})

const cap = Number(values.cap ?? 100_000)
const seed = Number(values.seed ?? 20_261_017)

if (!Number.isInteger(cap) || cap < 1) throw new Error(`--cap must be a positive integer, read ${values.cap}`)

if (!Number.isInteger(seed)) throw new Error(`--seed must be an integer, read ${values.seed}`)

const states = values.states ? values.states.split(",").map((s) => s.trim().toUpperCase()) : [...NAD_SKELETON_STATES]

const summary = await buildNADSkeletons({
	inputDirectory: values.input ?? dataRootPath("corpus", "sources", "usgov-nad", "featureserver"),
	states,
	cap,
	seed,
	zipCityCounties: NAD_ZIP_CITY_COUNTIES,
	onPage: (read, total) => {
		if (read % 50 === 0 || read === total) {
			console.error(`  ${read}/${total} pages`)
		}
	},
})

await writeNADSkeletonSummary(summary, dataRootPath(NAD_SKELETON_DIRECTORY, "SUMMARY.json"))

const percent = (share: number) => (100 * share).toFixed(1)

console.log(
	[
		"state",
		"usable",
		"unit%",
		"streetTypes",
		"zips",
		"prefixType%",
		"numericName%",
		"postDir%",
		"ruralRoute%",
		"hyphenNumber%",
		"gridNumber%",
		"sampled",
	].join("\t")
)

for (const shape of summary.shapes) {
	const sample = summary.samples.find((s) => s.region === shape.region)

	console.log(
		[
			shape.region,
			shape.usable,
			percent(shape.unitShare),
			shape.streetTypes,
			shape.zips,
			percent(shape.prefixTypeShare),
			percent(shape.numericNameShare),
			percent(shape.postDirectionalShare),
			percent(shape.ruralRouteShare),
			percent(shape.hyphenatedNumberShare),
			percent(shape.gridNumberShare),
			sample ? sample.rows : "",
		].join("\t")
	)
}

for (const table of summary.zipCity) {
	console.log(`zip-city ${table.county} ${table.region}: ${table.zips} ZIPs → ${table.path}`)
}
