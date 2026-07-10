/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build nl-pc6` — the NL full-postcode (PC6) shard (#977 tier 2) from the CBS
 *   Postcode6 centroid CSV (CC-BY 4.0). Sealed 0444. The pipeline module is lazy-imported so `--help`
 *   never faults without the optional `@mailwoman/resolver-wof-sqlite` peer.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	csv: zod.string().optional().describe("CBS PC6 centroid CSV. Default <data-root>/cbs/pc6-centroids.csv"),
	out: zod.string().optional().describe("Output shard. Default <data-root>/wof/postalcode-nl-pc6.db"),
})

export { OptionsSchema as options }

const GazetteerBuildNLPC6: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildNLPC6Shard } = await import("../../../gazetteer-pipeline/postcode/nl-pc6.ts")
		const r = await buildNLPC6Shard({ csvPath: options.csv, out: options.out })

		return `nl-pc6: ${r.inserted.toLocaleString()} PC6 rows (skipped ${r.skipped}) → ${r.out} — sealed 0444`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildNLPC6
