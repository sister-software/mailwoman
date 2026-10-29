/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts what a two-letter uppercase token teaches over one epoch, and prints the codes read both ways.
 *
 *   Usage: node packages/mailwoman/tools/training/audits/region-code-token.run.ts <config> [--json <path>] [--draws <n>]
 */

import { censusArguments, runMixtureCensus } from "./census.ts"
import { regionCodeTokenCensus } from "./region-code-token.ts"

const args = censusArguments()
const report = await runMixtureCensus(args, regionCodeTokenCensus)
const count = (n: number) => n.toLocaleString("en-US")

console.log(`region-code token census — ${args.config.split("/").at(-1)}`)
console.log(`  seed ${report.meta.seed}, ${count(report.meta.rows_drawn)} rows drawn`)

for (const level of ["draw_level", "emitted_level"] as const) {
	console.log(`  ${level.replace("_", " ")} — codes carrying BOTH readings:`)

	for (const [code, country, region] of report[level].contested) {
		const ratio = (country / Math.max(region, 1)).toFixed(1)

		console.log(
			`    ${code.padStart(6)} ${count(country).padStart(12)} ${count(region).padStart(12)} ${ratio.padStart(9)}:1`
		)
	}
}
