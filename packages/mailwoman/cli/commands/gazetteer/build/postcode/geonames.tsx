/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build postcode-geonames` — the GeoNames-postal tail database: postcode
 *   coverage for countries with no `whosonfirst-data-postalcode-<cc>` repo, GB included.
 *
 *   It writes to a new dated path and swaps no artifact. Promotion over the shipped database is a
 *   separate, deliberate step. GeoNames postal is CC-BY 4.0 and the GB rows have an additional OGL v3
 *   / Crown-copyright obligation from Ordnance Survey Code-Point Open — both ride in the artifact's
 *   `meta` table.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers/stat"

import {
	type CommandSpec,
	CommandSummaryLines,
	CommandTaskResult,
	type CommandComponent,
	phaseReporter,
	splitCountryCodes,
	useCommandTask,
} from "#cli-kit"
import { DEFAULT_GEONAMES_TAIL_COUNTRIES } from "#gazetteer/defaults"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "postcode-geonames",
	description: "Build the GeoNames postal tail database.",
	options: {
		countries: {
			type: "string",
			description: `Comma-separated ISO-2 codes. Default: ${DEFAULT_GEONAMES_TAIL_COUNTRIES.join(",")}`,
		},
		out: {
			type: "string",
			description: "Output path. Default <data-root>/db/wof/postalcode-geonames-tail-<YYYY-MM-DD>.db",
		},
		"geonames-postal": { type: "string", description: "GeoNames postal dump dir. Default <data-root>/geonames-postal" },
	},
} as const satisfies CommandSpec

const GazetteerBuildPostcodeGeonames: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildPostcodeGeonamesTail } = await import("#gazetteer-pipeline")

		const countries = options.countries ? splitCountryCodes(options.countries) : undefined

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
			"provenance + license in the `meta` table (GeoNames CC-BY 4.0; GB also OGL v3 / OS Code-Point Open)",
			"sealed 0444",
			"next: check on per-country parity vs the frozen database, THEN swap deliberately (wofExtractPaths)",
		]
	})

	// Progress streams to stderr, leaving stdout for the summary.
	if (state.status !== "done") return <CommandTaskResult state={state} />

	return <CommandSummaryLines lines={state.result} />
}

export default GazetteerBuildPostcodeGeonames
