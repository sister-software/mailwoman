/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build nz-localities` — the NZ suburb/locality shard (#1564, #1585's data
 *   half) from the LINZ-derived OpenAddresses countrywide extract (CC-BY 4.0, attribution LINZ).
 *   Sealed 0444. The pipeline module is lazy-imported so `--help` never faults without the optional
 *   `@mailwoman/resolver-wof-sqlite` peer.
 */

import { Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

const OptionsSchema = zod.object({
	csv: zod
		.string()
		.optional()
		.describe("LINZ-derived OA NZ countrywide CSV. Default <data-root>/openaddresses/extracted/nz/countrywide.csv"),
	out: zod.string().optional().describe("Output shard. Default <data-root>/wof/localities-nz-linz.db"),
})

export { OptionsSchema as options }

const GazetteerBuildNZLocalities: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildNZLocalitiesShard } = await import("../../../gazetteer-pipeline/nz-localities.ts")
		const r = await buildNZLocalitiesShard({ csvPath: options.csv, out: options.out })

		return `nz-localities: ${r.inserted.toLocaleString()} locality rows (skipped ${r.skippedGroups} thin groups, source md5 ${r.sourceMD5.slice(0, 8)}) → ${r.out} — sealed 0444`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildNZLocalities
