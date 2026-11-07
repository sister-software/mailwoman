/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build polygons` — the boundary file, one simplified polygon per place the gazetteer holds, from
 *   the Who's On First clones. Sealed 0444.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "polygons",
	description: "Build the Who's On First boundary file for the places the gazetteer holds.",
	options: {
		out: { type: "string", description: "Output database. Default <data-root>/db/wof/wof-polygons.db" },
		countries: { type: "string", description: "Comma-separated lower-case country codes. Default every country" },
		tolerance: { type: "string", description: "Simplification tolerance in degrees. Default 0.001" },
		postcodes: { type: "boolean", description: "Also read each country's postcode repository." },
	},
} as const satisfies CommandSpec

const GazetteerBuildPolygons: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildPolygonsDatabase } = await import("@mailwoman/gazetteer/tools/pipeline/polygons")

		const { out, counts } = await buildPolygonsDatabase({
			...(options.out ? { out: options.out } : {}),
			...(options.countries ? { countries: options.countries.split(",") } : {}),
			...(options.tolerance ? { tolerance: Number(options.tolerance) } : {}),
			postcodes: options.postcodes === true,
			onProgress: (progress) => console.error(`polygons: ${stringifyJSON(progress)}`),
		})

		return `polygons: ${stringifyJSON(counts)} → ${out} — sealed 0444`
	})

	return <CommandTaskResult state={state} />
}

export default GazetteerBuildPolygons
