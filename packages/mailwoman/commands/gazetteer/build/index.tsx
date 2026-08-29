/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build` — the whole data pipeline, turnkey: `build admin` (WOF + Overture +
 *   GeoNames → verified, sealed admin gazetteer) then `build candidate` (the byte-range candidate
 *   table) FROM that fresh admin artifact. The legacy standalone GeoNames fold is skipped here — the
 *   admin build already folds the full 161-country set upstream (a superset of the old fold list).
 *   Both artifacts land at STAGING/dated paths; swapping/promoting stays deliberate (RELEASING.md).
 */

import { join } from "@mailwoman/platform/path"
import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "build",
	description: "Build the admin and candidate gazetteers.",
	options: {
		data: { type: "string", description: "WOF repos root. Default <data-root>/wof/repos" },
		"skip-verify": { type: "boolean", default: false, description: "Skip the admin verify gate (development only)" },
	},
} as const satisfies CommandSpec

interface Options {
	data?: string
	skipVerify: boolean
}

const GazetteerBuild: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { artifactSizeMB, buildAdmin, buildCandidate, DEFAULT_CANDIDATE_OUT, resolvePostcodeShards, wofDir } =
			await import("#gazetteer-pipeline")

		console.error("▸ build admin (staging)")

		const admin = await buildAdmin({
			dataDir: options.data,
			skipVerify: options.skipVerify,
			onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
		})

		const candidateOut = join(wofDir(), DEFAULT_CANDIDATE_OUT)

		console.error(`▸ build candidate ← ${admin.out}`)

		const shards = resolvePostcodeShards()

		const candidate = await buildCandidate({
			adminDB: admin.out,
			out: candidateOut,
			postcodeShards: shards,
			onProgress: (phase, msg) => console.error(`  [${phase}] ${msg}`),
		})

		return [
			`admin: ${admin.out} (${artifactSizeMB(admin.out)} MB) — ${admin.verify ? "verify PASS" : "verify SKIPPED"}, sealed`,
			`candidate: ${candidateOut} (${artifactSizeMB(candidateOut)} MB) — ${candidate.rows.toLocaleString()} rows, sealed`,
			"next: mailwoman gazetteer verify --db <admin>, then swap + promote per RELEASING.md",
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

export default GazetteerBuild
