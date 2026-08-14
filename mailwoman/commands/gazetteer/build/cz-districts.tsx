/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build cz-districts` — the Prague municipal-district locality shard (the
 *   `Praha 9` coherence class) from the GeoNames CZ places file (CC-BY 4.0, attribution GeoNames).
 *   Sealed 0444. The pipeline module is lazy-imported so `--help` never faults without the optional
 *   `@mailwoman/resolver-wof-sqlite` peer.
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "cz-districts",
	description: "Build the Prague municipal-district locality shard.",
	options: {
		source: { type: "string", description: "GeoNames CZ places file. Default <data-root>/geonames/CZ.txt" },
		out: { type: "string", description: "Output shard. Default <data-root>/wof/localities-cz-districts.db" },
	},
} as const satisfies CommandSpec

interface Options {
	source?: string
	out?: string
}

const GazetteerBuildCZDistricts: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildCZDistrictsShard } = await import("../../../gazetteer-pipeline/cz-districts.ts")
		const r = await buildCZDistrictsShard({ sourcePath: options.source, out: options.out })

		return `cz-districts: ${r.inserted} district rows (source md5 ${r.sourceMD5.slice(0, 8)}) → ${r.out} — sealed 0444`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildCZDistricts
