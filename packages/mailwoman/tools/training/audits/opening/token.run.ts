/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts what a row's opening token teaches over one epoch, at the draw and emitted levels.
 *
 *   Usage: node packages/mailwoman/tools/training/audits/opening/token.run.ts <config> [--json <path>] [--draws <n>]
 */

import { censusArguments, runMixtureCensus } from "../census.ts"
import { OPENING_NAMES, openingTokenCensus } from "./token.ts"

const args = censusArguments()
const report = await runMixtureCensus(args, openingTokenCensus)
const { meta } = report
const count = (n: number) => n.toLocaleString("en-US")

console.log(`opening-token census — ${args.config.split("/").at(-1)}`)
console.log(`  seed ${meta.seed}, ${count(meta.rows_drawn)} rows drawn, ${count(meta.rows_emitted)} rows emitted`)

for (const name of OPENING_NAMES) {
	const drawn = count(report.draw_level.counts[name]).padStart(12)
	const emitted = count(report.emitted_level.counts[name]).padStart(12)

	console.log(`  ${name.padEnd(24)} ${drawn} ${emitted}`)
}
