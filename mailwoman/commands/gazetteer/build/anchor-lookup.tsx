/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build anchor-lookup` — the postcode→anchor JSON lookup (#239/#240; LIVE
 *   consumer: `@mailwoman/neural`'s scorer + the eval harnesses). JSON artifact, write-once semantics
 *   (regenerate, don't edit).
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	output: zod.string().describe("Output JSON path (e.g. pilot-anchor-lookup.json)"),
	zcta: zod.string().optional().describe("Census ZCTA Gazetteer file for the US placeholder fill"),
})

export { OptionsSchema as options }

const GazetteerBuildAnchorLookup: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildAnchorLookup } = await import("../../../gazetteer-pipeline/anchor-lookup.ts")
		buildAnchorLookup({ output: options.output, zcta: options.zcta })

		return `anchor lookup → ${options.output}`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildAnchorLookup
