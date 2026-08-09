/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build postcode-codepoint` — the GB unit-postcode shard from Ordnance Survey
 *   Code-Point Open (OGL v3). Acquires the archive from the open OS Downloads API, verifies it against
 *   OS's published md5, converts OSGB36 eastings/northings to WGS84, and writes a sealed shard to a NEW
 *   DATED path. Promotion into `DEFAULT_POSTCODE_SHARDS` is a separate, deliberate step.
 *
 *   Coverage is England, Scotland and Wales. Northern Ireland is NOT in this product and the shard says
 *   so in its own `meta`; see the pipeline module for the licensing reason.
 *
 *   The pipeline module is lazy-imported so `--help` never faults without the optional
 *   `@mailwoman/resolver-wof-sqlite` peer.
 */

import { Box, Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

import { artifactSizeMB } from "../../../gazetteer-pipeline/index.ts"

const OptionsSchema = zod.object({
	sourceDir: zod
		.string()
		.optional()
		.describe("Acquisition dir for codepo_gb.zip + extracted CSVs. Default <data-root>/codepoint/<YYYY-MM-DD>"),
	out: zod.string().optional().describe("Output path. Default <data-root>/wof/postalcode-gb-codepoint-<YYYY-MM-DD>.db"),
	offline: zod.boolean().optional().describe("Skip the download and use whatever is already in --source-dir"),
})

export { OptionsSchema as options }

const GazetteerBuildPostcodeCodePoint: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildPostcodeCodePoint } = await import("../../../gazetteer-pipeline/postcode/codepoint-shard.ts")

		const result = await buildPostcodeCodePoint({
			sourceDir: options.sourceDir,
			out: options.out,
			offline: options.offline,
			onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
		})

		const { stats, metadata } = result

		return [
			`postcode codepoint: ${result.out} (${artifactSizeMB(result.out)} MB)`,
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
			"next: gate vs the incumbent GeoNames GB rows, THEN swap DEFAULT_POSTCODE_SHARDS deliberately",
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

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
