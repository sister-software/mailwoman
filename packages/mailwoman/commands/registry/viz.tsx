/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry viz <figure>` — emit one of the record-matcher figures (HTML/SVG). The map
 *   figures (`cross-dataset-map`, `source-provenance-map`) must be SERVED OVER LOCALHOST to render
 *   their basemap (the house tile server CORS-restricts to localhost + the docs domains). PNG
 *   rendering stays programmatic via `renderPlotlyHTMLToPNG` / `renderServedMapToPNG` in
 *   `@mailwoman/registry/tools` (lazy playwright).
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

const figures = ["cross-dataset-map", "geocode-first-surface", "source-provenance-map", "yardstick-figure"] as const

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "viz",
	description: "Render record-matcher figures.",
	positionals: [{ name: "figure", required: true, choices: figures, description: "Figure id" }],
	options: {
		in: { type: "string", description: "Cross-dataset links GeoJSON" },
		"cross-agency-only": { type: "boolean", default: false, description: "Keep only cross-agency entities" },
		lambda: { type: "number", description: "Illustrative prior lambda" },
		state: { type: "string", description: "State Postcode" },
		db: { type: "string", description: "Address-point database" },
		"nad-mod": { type: "number", description: "NAD sampling modulus" },
		"oa-mod": { type: "number", description: "OpenAddresses sampling modulus" },
		cap: { type: "number", description: "Per-source marker cap" },
		"out-html": { type: "string", description: "Output HTML path" },
		"out-svg": { type: "string", description: "Output SVG path" },
	},
} as const satisfies CommandSpec

interface Options {
	in?: string
	crossAgencyOnly: boolean
	lambda?: number
	state?: string
	db?: string
	nadMod?: number
	oaMod?: number
	cap?: number
	outHTML?: string
	outSVG?: string
}

type Figure = (typeof figures)[number]

const report = (line: string): void => console.error(line)

async function runFigure(figure: Figure, options: Options): Promise<string> {
	const { crossDatasetMap, geocodeFirstSurface, sourceProvenanceMap, yardstickFigure } =
		await import("@mailwoman/registry/tools")

	switch (figure) {
		case "cross-dataset-map":
			return crossDatasetMap(
				{ in: options.in, outHTML: options.outHTML, crossAgencyOnly: options.crossAgencyOnly },
				report
			).outHTML
		case "geocode-first-surface":
			return geocodeFirstSurface({ lambda: options.lambda, outHTML: options.outHTML }, report).outHTML
		case "source-provenance-map":
			return sourceProvenanceMap(
				{
					state: options.state,
					db: options.db,
					outHTML: options.outHTML,
					nadMod: options.nadMod,
					oaMod: options.oaMod,
					cap: options.cap,
				},
				report
			).outHTML
		case "yardstick-figure":
			return yardstickFigure({ outSVG: options.outSVG }, report).outSVG
	}
}

const RegistryViz: ParsedCommandComponent<Options, [Figure]> = ({ options, args }) => {
	const state = useCommandTask(() => runFigure(args[0], options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Text color="green">
				{args[0]} → {state.result}
			</Text>
		)
	}

	return null
}

export default RegistryViz
