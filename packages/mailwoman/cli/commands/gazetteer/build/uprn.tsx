/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build uprn` — the OS Open UPRN spatial layer (`uprn.db`): every GB Unique
 *   Property Reference Number with OS's own WGS84 point. It acquires the archive from the open OS
 *   Downloads API. It verifies the archive against OS's published md5 and writes a sealed, atomically-swapped
 *   artifact. The layer is an interoperability key source. No step on the parse/resolve path reads it.
 *
 *   Coverage includes England, Scotland and Wales. Northern Ireland's identifiers live in LPS Pointer,
 *   outside OS OpenData products. The layer's coverage rows record that distinction.
 *
 *   The pipeline module is lazy-imported so `--help` never faults without the optional
 *   `@mailwoman/resolver-wof-sqlite` peer.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers/stat"

import {
	type CommandSpec,
	CommandSummaryLines,
	CommandTaskResult,
	type CommandComponent,
	phaseReporter,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "uprn",
	description: "Build the OS Open UPRN layer database.",
	options: {
		"source-dir": { type: "string", description: "Acquisition dir for osopenuprn_*.zip and extracted CSV" },
		out: { type: "string", description: "Output path. Default <data-root>/db/uprn/uprn.db" },
		offline: { type: "boolean", description: "Skip the download and use --source-dir contents" },
	},
} as const satisfies CommandSpec

const GazetteerBuildUPRN: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { repoRootPath } = await import("@mailwoman/core/paths")
		const { buildSHA } = await import("#gazetteer/stamp-manifest")
		const { buildUPRNLayer, OPEN_UPRN_COVERAGE_NOTE } = await import("#gazetteer/uprn-layer")

		const result = await buildUPRNLayer({
			sourceDir: options.sourceDir,
			out: options.out,
			offline: options.offline,
			buildSHA: buildSHA(repoRootPath()),
			onPhase: phaseReporter(),
		})

		return [
			`uprn layer: ${result.out} (${await formatFileSize(result.out)})`,
			`${result.inserted.toLocaleString()} UPRN points — OS release ${result.osVersion}`,
			`read ${result.read.toLocaleString()} · malformed ${result.skippedMalformed.toLocaleString()} · duplicate ${result.skippedDuplicate.toLocaleString()} (both expected zero)`,
			`coverage ${result.coverageCells.toLocaleString()} res-6 cells (basis: designated)`,
			`archive md5 ${result.archiveMD5 || "(offline — not re-verified)"}`,
			result.mismatches.length ? `CHECK VIOLATIONS: ${result.mismatches.join(" · ")}` : "every check holds",
			OPEN_UPRN_COVERAGE_NOTE,
			"license + full OGL v3 attribution block in the layer manifest",
			result.sealed ? "sealed 0444" : "NOT SEALED",
		]
	})

	// Progress streams to stderr, leaving stdout for the summary.
	if (state.status !== "done") return <CommandTaskResult state={state} />

	return <CommandSummaryLines lines={state.result} />
}

export default GazetteerBuildUPRN
