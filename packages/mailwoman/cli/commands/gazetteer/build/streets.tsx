/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build streets` — the street table, merged streets and their crossings tied to the gazetteer's
 *   places, from a road network source. Sealed 0444.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "streets",
	description: "Build the street table from OS Open Roads, the first road network source.",
	options: {
		out: { type: "string", description: "Output database. Default <data-root>/db/wof/streets-gb-os-open-roads.db" },
		input: {
			type: "string",
			description: "Directory of Open Roads GML. Default <data-root>/corpus/sources/gb-os-open/open-roads/data",
		},
	},
} as const satisfies CommandSpec

const GazetteerBuildStreets: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildStreetTable } = await import("@mailwoman/gazetteer/tools/pipeline/streets")
		const { readOpenRoadsEdges } = await import("@mailwoman/gazetteer/tools/pipeline/streets/gb-os-open-roads")
		const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")
		const out = options.out ?? wofDatabasePath("streets-gb-os-open-roads.db")

		const counts = await buildStreetTable({
			edges: readOpenRoadsEdges(options.input ?? dataRootPath("corpus/sources/gb-os-open/open-roads/data")),
			countries: ["GB"],
			out,
			onProgress: (progress) => console.error(`streets: ${stringifyJSON(progress)}`),
		})

		return `streets: ${stringifyJSON(counts)} → ${out} — sealed 0444`
	})

	return <CommandTaskResult state={state} />
}

export default GazetteerBuildStreets
