/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build anchor-lookup` — the postcode→anchor JSON lookup (#239/#240; LIVE
 *   consumer: `@mailwoman/neural`'s scorer + the eval harnesses). JSON artifact, write-once semantics
 *   (regenerate, don't edit).
 *
 *   `--include` picks the country set. It defaults to the DE/FR/US pilot — the set every shipped
 *   recipe trained against, and the set whose 67,708 keys are ALL five digits, which is why the
 *   encoder's GB/JP/ES/IT/NL anchor slots never took a gradient
 *   (`docs/records/evals/2026-08-05-en-gb-anchor-off.md`). Pass `--include DE,FR,US,GB,NL,ES,IT` for
 *   the letter-bearing v2 set. Widening the lookup only pays off on a run that ALSO carries the
 *   inference-side parity fix — see the pipeline module docstring.
 */

import { Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

const OptionsSchema = zod.object({
	output: zod.string().describe("Output JSON path (e.g. pilot-anchor-lookup.json)"),
	zcta: zod.string().optional().describe("Census ZCTA Gazetteer file for the US placeholder fill"),
	include: zod
		.string()
		.optional()
		.describe("Comma-separated country codes in centroid-priority order (default: DE,FR,US)"),
	gbOutward: zod.boolean().default(true).describe("Emit GB outward-district keys beside the unit keys"),
})

export { OptionsSchema as options }

const GazetteerBuildAnchorLookup: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildAnchorLookup } = await import("../../../gazetteer-pipeline/anchor-lookup.ts")

		const stats = buildAnchorLookup({
			output: options.output,
			zcta: options.zcta,
			include: options.include
				?.split(",")
				.map((c) => c.trim())
				.filter(Boolean),
			gbOutward: options.gbOutward,
		})

		return `anchor lookup → ${options.output} (${stats.total} keys, ${stats.letterBearing} letter-bearing)`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildAnchorLookup
