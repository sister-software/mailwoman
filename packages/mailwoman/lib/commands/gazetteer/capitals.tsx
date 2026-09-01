/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer capitals` — build the capital-status reference (#1880) from the GeoNames
 *   gazetteer dumps (`mailwoman corpus fetch geonames-dump`). See
 *   `gazetteer-pipeline/capitals.ts` for what the reference is and how the resolver consumes it.
 *
 *   Output: data/gazetteer/capitals-v1.json (small, committed, provenance-tracked).
 */

import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "capitals",
	description: "Build the capital-status reference",
	options: {
		geonames: { type: "string", description: "GeoNames dump directory. Default <data-root>/geonames" },
		output: { type: "string", description: "Output path. Default <repo>/data/gazetteer/capitals-v1.json" },
	},
} as const satisfies CommandSpec

interface Options {
	geonames?: string
	output?: string
}

const GazetteerCapitals: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildCapitalsReference } = await import("#gazetteer/capitals")
		const { dataRootPath, repoRootPathBuilder } = await import("@mailwoman/core/utils")

		const result = await buildCapitalsReference({
			geonamesDir: options.geonames ?? String(dataRootPath("geonames")),
			outPath: options.output ?? String(repoRootPathBuilder("data", "gazetteer", "capitals-v1.json")),
		})

		const c = result.coverage

		return [
			result.outPath,
			`${c.countries_scanned} countries scanned — ${c.national} national capitals, ${c.admin1} admin-1 seats`,
			`missing dumps: ${c.missing_dumps.length ? c.missing_dumps.join(", ") : "none"}`,
			`wrong-format files: ${c.wrong_format.length ? c.wrong_format.join(", ") : "none"}`,
			`no PPLC row: ${c.missing_national.length ? c.missing_national.join(", ") : "none"}`,
			`catalog-name mismatches: ${c.capital_name_mismatches.length}`,
		]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ wrote " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerCapitals
