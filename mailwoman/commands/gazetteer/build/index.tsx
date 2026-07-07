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

import { join } from "node:path"

import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import {
	artifactSizeMB,
	buildAdmin,
	buildCandidate,
	DEFAULT_CANDIDATE_OUT,
	resolvePostcodeShards,
	wofDir,
} from "../../../gazetteer-pipeline/index.js"
import type { CommandComponent } from "../../../sdk/cli.js"

const OptionsSchema = zod.object({
	data: zod.string().optional().describe("WOF repos root. Default <data-root>/wof/repos"),
	skipVerify: zod
		.boolean()
		.default(false)
		.describe("Skip the admin verify gate (dev only — an unverified artifact must never be promoted)"),
})

export { OptionsSchema as options }

const GazetteerBuild: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
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
					adminDb: admin.out,
					out: candidateOut,
					postcodeShards: shards,
					onProgress: (phase, msg) => console.error(`  [${phase}] ${msg}`),
				})

				setSummary([
					`admin: ${admin.out} (${artifactSizeMB(admin.out)} MB) — ${admin.verify ? "verify PASS" : "verify SKIPPED"}, sealed`,
					`candidate: ${candidateOut} (${artifactSizeMB(candidateOut)} MB) — ${candidate.rows.toLocaleString()} rows, sealed`,
					"next: mailwoman gazetteer verify --db <admin>, then swap + promote per RELEASING.md",
				])
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (summary || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [summary, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (summary) {
		return (
			<Box flexDirection="column">
				{summary.map((line, i) => (
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
