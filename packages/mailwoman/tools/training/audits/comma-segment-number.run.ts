/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts bare numbers in comma segments over one epoch, at both the draw and emitted levels.
 *
 *   Usage: node packages/mailwoman/tools/training/audits/comma-segment-number.run.ts <config> [--json <path>] [--draws <n>]
 */

import { censusArguments, runMixtureCensus } from "./census.ts"
import { commaSegmentNumberCensus } from "./comma-segment-number.ts"

const args = censusArguments()
const report = await runMixtureCensus(args, commaSegmentNumberCensus)
const count = (n: number) => n.toLocaleString("en-US")

console.log(`comma-segment number census — ${args.config.split("/").at(-1)}`)
console.log(`  seed ${report.meta.seed}, ${count(report.meta.rows_drawn)} rows drawn`)

for (const level of ["draw_level", "emitted_level"] as const) {
	console.log(`  ${level.replace("_", " ")}:`)

	for (const where of ["leading", "later"] as const) {
		const tags = Object.entries(report[level][where])

		console.log(`    ${where.padEnd(9)} ${count(tags.reduce((sum, [, n]) => sum + n, 0)).padStart(10)}`)

		for (const [tag, n] of tags.toSorted((a, b) => b[1] - a[1])) {
			console.log(`      ${tag.padEnd(20)} ${count(n).padStart(10)}`)
		}
	}
}
