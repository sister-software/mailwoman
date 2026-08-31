/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build postcode-geonames` — the GeoNames-postal tail shard (#920): the
 *   postcode coverage for countries with no `whosonfirst-data-postalcode-<cc>` repo, GB included.
 *   Ingest the `<CC>.txt` dumps → self-ancestors → indexes → provenance `meta` → FTS → SEAL.
 *
 *   This is the reproducer for `postalcode-geonames-tail.db`, an artifact that spent a year with no
 *   way to rebuild it after #1027 deleted its `build-unified-wof` Phase-2d builder. It writes to a
 *   NEW DATED path and swaps nothing; promotion over the shipped shard is a separate, deliberate
 *   step. GeoNames postal is CC-BY 4.0 and the GB rows carry an additional OGL v3 / Crown-copyright
 *   obligation from Ordnance Survey Code-Point Open — both ride in the artifact's `meta` table.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers"
import { Box, Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	phaseReporter,
	splitUpperList,
	useCommandTask,
} from "#cli-kit"
import { DEFAULT_GEONAMES_TAIL_COUNTRIES } from "#gazetteer-pipeline/defaults"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "postcode-geonames",
	description: "Build the GeoNames postal tail shard.",
	options: {
		countries: {
			type: "string",
			description: `Comma-separated ISO-2 codes. Default: ${DEFAULT_GEONAMES_TAIL_COUNTRIES.join(",")}`,
		},
		out: {
			type: "string",
			description: "Output path. Default <data-root>/wof/postalcode-geonames-tail-<YYYY-MM-DD>.db",
		},
		"geonames-postal": { type: "string", description: "GeoNames postal dump dir. Default <data-root>/geonames-postal" },
	},
} as const satisfies CommandSpec

interface Options {
	countries?: string
	out?: string
	geonamesPostal?: string
}

const GazetteerBuildPostcodeGeonames: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildPostcodeGeonamesTail } = await import("#gazetteer-pipeline")

		const countries = options.countries ? splitUpperList(options.countries) : undefined

		const result = await buildPostcodeGeonamesTail({
			countries,
			out: options.out,
			postalDir: options.geonamesPostal,
			onPhase: phaseReporter(),
		})

		const perCountry = result.countries.map((cc) => `${cc} ${(result.byCountry[cc] ?? 0).toLocaleString()}`).join(" · ")

		return [
			`postcode geonames tail: ${result.out} (${await formatFileSize(result.out)})`,
			`${result.inserted.toLocaleString()} distinct postcodes — ${perCountry}`,
			`fts ${result.ftsRows.toLocaleString()} · bbox ${result.bboxRows.toLocaleString()} · ancestors ${result.ancestorRows.toLocaleString()}`,
			result.missing.length ? `MISSING dumps (skipped): ${result.missing.join(",")}` : "all requested dumps present",
			"provenance + licence in the `meta` table (GeoNames CC-BY 4.0; GB also OGL v3 / OS Code-Point Open)",
			"sealed 0444",
			"next: gate on per-country parity vs the frozen shard, THEN swap deliberately (wofShardPaths)",
		]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null // progress streams to stderr until the summary lands
}

export default GazetteerBuildPostcodeGeonames
