/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build postcode-codepoint` — the GB unit-postcode database from Ordnance Survey
 *   Code-Point Open (OGL v3). Acquires the archive from the open OS Downloads API, verifies it against
 *   OS's published md5, converts OSGB36 eastings/northings to WGS84, and writes a sealed database to a NEW
 *   DATED path. Promotion into `DEFAULT_POSTCODE_DATABASES` is a separate, deliberate step.
 *
 *   Coverage is England, Scotland and Wales. Northern Ireland is NOT in this product and the database says
 *   so in its own `meta`; see the pipeline module for the licensing reason.
 *
 *   The pipeline module is lazy-imported so `--help` never faults without the optional
 *   `@mailwoman/resolver-wof-sqlite` peer.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers"
import { Box, Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	phaseReporter,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "postcode-codepoint",
	description: "Build the GB Code-Point Open unit-postcode database.",
	options: {
		"source-dir": { type: "string", description: "Acquisition dir for codepo_gb.zip and extracted CSVs" },
		out: {
			type: "string",
			description: "Output path. Default <data-root>/wof/postalcode-gb-codepoint-<YYYY-MM-DD>.db",
		},
		offline: { type: "boolean", description: "Skip the download and use --source-dir contents" },
	},
} as const satisfies CommandSpec

interface Options {
	sourceDir?: string
	out?: string
	offline?: boolean
}

const GazetteerBuildPostcodeCodePoint: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildPostcodeCodePoint } = await import("#gazetteer/postcode/codepoint-database")

		const result = await buildPostcodeCodePoint({
			sourceDir: options.sourceDir,
			out: options.out,
			offline: options.offline,
			onPhase: phaseReporter(),
		})

		const { stats, metadata } = result

		return [
			`postcode codepoint: ${result.out} (${await formatFileSize(result.out)})`,
			`${result.inserted.toLocaleString()} unit postcodes — OS release ${result.osVersion} (dataset ${metadata.datasetVersion}, © ${metadata.copyrightDate})`,
			`read ${stats.read.toLocaleString()} · dropped ${stats.skippedNoCoordinate.toLocaleString()} no-coordinate (PQI 90) · ${stats.skippedMalformed.toLocaleString()} malformed`,
			`manifest claims ${metadata.totalRows.toLocaleString()} rows across ${Object.keys(metadata.rowsByArea).length} areas — ${
				!result.manifestMismatches.length
					? "every area reconciles"
					: `MISMATCHES: ${result.manifestMismatches.join(" · ")}`
			}`,
			`fts ${result.ftsRows.toLocaleString()} · bbox ${result.bboxRows.toLocaleString()} · ancestors ${result.ancestorRows.toLocaleString()}`,
			`archive md5 ${result.archiveMD5 || "(offline — not re-verified)"}`,
			"coverage: England/Scotland/Wales only — ZERO Northern Ireland (BT) postcodes, by product definition",
			"licence + full OGL v3 attribution block in the `meta` table",
			"sealed 0444",
			"next: check vs the incumbent GeoNames GB rows, THEN swap DEFAULT_POSTCODE_DATABASES deliberately",
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

export default GazetteerBuildPostcodeCodePoint
