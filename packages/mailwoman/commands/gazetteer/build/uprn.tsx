/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build uprn` — the OS Open UPRN spatial layer (`uprn.db`): every GB Unique
 *   Property Reference Number with OS's own WGS84 point, under the layer contract. Acquires the
 *   archive from the open OS Downloads API (same product family as Code-Point Open), verifies it
 *   against OS's published md5, and writes a sealed, atomically-swapped artifact. The layer is an
 *   interoperability key source — nothing on the parse/resolve path reads it.
 *
 *   Coverage is England, Scotland and Wales; Northern Ireland's identifiers live in LPS Pointer, not
 *   any OS OpenData product, and the layer's own coverage rows say so. See
 *   `gazetteer-pipeline/uprn-layer.ts` for the gates (md5, exact header, accounting identity, row
 *   floor).
 *
 *   The pipeline module is lazy-imported so `--help` never faults without the optional
 *   `@mailwoman/resolver-wof-sqlite` peer.
 */

import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "uprn",
	description: "Build the OS Open UPRN layer database.",
	options: {
		"source-dir": { type: "string", description: "Acquisition dir for osopenuprn_*.zip and extracted CSV" },
		out: { type: "string", description: "Output path. Default <data-root>/uprn/uprn.db" },
		offline: { type: "boolean", description: "Skip the download and use --source-dir contents" },
	},
} as const satisfies CommandSpec

interface Options {
	sourceDir?: string
	out?: string
	offline?: boolean
}

const GazetteerBuildUPRN: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { repoRootPath } = await import("@mailwoman/core/utils")
		const { artifactSizeMB } = await import("#gazetteer-pipeline")
		const { buildSHA } = await import("#gazetteer/stamp-manifest")
		const { buildUPRNLayer, OPEN_UPRN_COVERAGE_NOTE } = await import("#gazetteer/uprn-layer")

		const result = await buildUPRNLayer({
			sourceDir: options.sourceDir,
			out: options.out,
			offline: options.offline,
			buildSHA: buildSHA(String(repoRootPath())),
			onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
		})

		return [
			`uprn layer: ${result.out} (${await artifactSizeMB(result.out)} MB)`,
			`${result.inserted.toLocaleString()} UPRN points — OS release ${result.osVersion}`,
			`read ${result.read.toLocaleString()} · malformed ${result.skippedMalformed.toLocaleString()} · duplicate ${result.skippedDuplicate.toLocaleString()} (both expected zero)`,
			`coverage ${result.coverageCells.toLocaleString()} res-6 cells (basis: designated)`,
			`archive md5 ${result.archiveMD5 || "(offline — not re-verified)"}`,
			result.mismatches.length ? `GATE VIOLATIONS: ${result.mismatches.join(" · ")}` : "every gate holds",
			OPEN_UPRN_COVERAGE_NOTE,
			"licence + full OGL v3 attribution block in the layer manifest",
			result.sealed ? "sealed 0444" : "NOT SEALED",
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

export default GazetteerBuildUPRN
