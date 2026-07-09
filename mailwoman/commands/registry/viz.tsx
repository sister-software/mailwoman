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

import { crossDatasetMap, geocodeFirstSurface, sourceProvenanceMap, yardstickFigure } from "@mailwoman/registry/tools"
import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

export const args = zod.tuple([
	zod.enum(["cross-dataset-map", "geocode-first-surface", "source-provenance-map", "yardstick-figure"]).describe(
		argument({
			name: "figure",
			description: "Figure id (cross-dataset-map, geocode-first-surface, source-provenance-map, yardstick-figure)",
		})
	),
])

const OptionsSchema = zod.object({
	// cross-dataset-map
	in: zod.string().optional().describe("cross-dataset-map: the cross-dataset-links GeoJSON"),
	crossAgencyOnly: zod
		.boolean()
		.default(false)
		.describe("cross-dataset-map: keep only entities spanning >1 agency (FCC datasets count as one)"),
	// geocode-first-surface
	lambda: zod.number().optional().describe("geocode-first-surface: illustrative prior λ (default 0.02)"),
	// source-provenance-map
	state: zod.string().optional().describe("source-provenance-map: state, lowercase postal (default ny)"),
	db: zod.string().optional().describe("source-provenance-map: address-point DB path"),
	nadMod: zod.number().optional().describe("source-provenance-map: keep ~1/N of NAD points (default 700)"),
	oaMod: zod.number().optional().describe("source-provenance-map: keep ~1/N of OpenAddresses points (default 120)"),
	cap: zod.number().optional().describe("source-provenance-map: per-source marker cap (default 7000)"),
	// shared outputs
	outHtml: zod.string().optional().describe("HTML figures: output path (each figure has a /tmp default)"),
	outSvg: zod
		.string()
		.optional()
		.describe("yardstick-figure: output SVG path (default docs/articles/evals/charts/dedup-yardstick.svg)"),
})

export { OptionsSchema as options }

type Options = zod.infer<typeof OptionsSchema>
type Figure = zod.infer<typeof args>[0]

const report = (line: string): void => console.error(line)

function runFigure(figure: Figure, options: Options): string {
	switch (figure) {
		case "cross-dataset-map":
			return crossDatasetMap(
				{ in: options.in, outHtml: options.outHtml, crossAgencyOnly: options.crossAgencyOnly },
				report
			).outHtml
		case "geocode-first-surface":
			return geocodeFirstSurface({ lambda: options.lambda, outHtml: options.outHtml }, report).outHtml
		case "source-provenance-map":
			return sourceProvenanceMap(
				{
					state: options.state,
					db: options.db,
					outHtml: options.outHtml,
					nadMod: options.nadMod,
					oaMod: options.oaMod,
					cap: options.cap,
				},
				report
			).outHtml
		case "yardstick-figure":
			return yardstickFigure({ outSvg: options.outSvg }, report).outSvg
	}
}

const RegistryViz: CommandComponent<typeof OptionsSchema, typeof args> = ({ options, args }) => {
	const state = useCommandTask(async () => runFigure(args[0], options))

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
