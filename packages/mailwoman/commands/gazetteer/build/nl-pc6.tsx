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

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "nl-pc6",
	description: "Build the Netherlands PC6 postcode shard.",
	options: {
		csv: { type: "string", description: "CBS PC6 centroid CSV. Default <data-root>/cbs/pc6-centroids.csv" },
		out: { type: "string", description: "Output shard. Default <data-root>/wof/postalcode-nl-pc6.db" },
	},
} as const satisfies CommandSpec

interface Options {
	csv?: string
	out?: string
}

const GazetteerBuildNLPC6: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildNLPC6Shard } = await import("#gazetteer/postcode/nl-pc6")
		const r = await buildNLPC6Shard({ csvPath: options.csv, out: options.out })

		return `nl-pc6: ${r.inserted.toLocaleString()} PC6 rows (skipped ${r.skipped}) → ${r.out} — sealed 0444`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildNLPC6
