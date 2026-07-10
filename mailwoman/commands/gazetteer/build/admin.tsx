/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build admin` — the turnkey admin-gazetteer build: WOF ingest → Overture
 *   divisions (real `division_area` extents + country nodes, #1015) → GeoNames folds → freeze →
 *   enrich (region abbrevs + place_abbr) → FTS → the structural VERIFY gate (#1026 node census,
 *   reverse EU panel) → SEAL 0444. Builds to a STAGING path; swapping over the live DB is a separate,
 *   deliberate step (RELEASING.md). The coverage recipe lives in `gazetteer-pipeline/defaults.ts`.
 */

import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"
import { artifactSizeMB, buildAdmin } from "../../../gazetteer-pipeline/index.ts"

const OptionsSchema = zod.object({
	data: zod.string().optional().describe("WOF repos root. Default <data-root>/wof/repos"),
	out: zod.string().optional().describe("Output path. Default <data-root>/wof/admin-global-priority.REBUILD.db"),
	overtureCountries: zod
		.string()
		.optional()
		.describe("CSV override of the Overture set (default: the 86 in defaults.ts)"),
	geonamesCountries: zod
		.string()
		.optional()
		.describe("CSV override of the GeoNames set (default: the 161 in defaults.ts)"),
	overtureRelease: zod.string().optional().describe("Pinned Overture release (default: defaults.ts)"),
	skipVerify: zod
		.boolean()
		.default(false)
		.describe("Skip the verify gate (dev only — an unverified artifact must never be promoted)"),
})

export { OptionsSchema as options }

const csv = (raw: string | undefined): string[] | undefined =>
	raw
		? raw
				.split(",")
				.map((s) => s.trim().toUpperCase())
				.filter(Boolean)
		: undefined

const GazetteerBuildAdmin: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const result = await buildAdmin({
			dataDir: options.data,
			out: options.out,
			overtureCountries: csv(options.overtureCountries),
			geonamesCountries: csv(options.geonamesCountries),
			overtureRelease: options.overtureRelease,
			skipVerify: options.skipVerify,
			onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
		})

		return [
			`admin gazetteer: ${result.out} (${artifactSizeMB(result.out)} MB, ${result.elapsedSeconds}s)`,
			`${result.placesIngested.toLocaleString()} WOF + ${result.overtureIngested.toLocaleString()} overture + ${result.geonamesIngested.toLocaleString()} geonames`,
			result.verify ? `verify: PASS (${result.verify.checks.length} checks)` : "verify: SKIPPED (--skip-verify)",
			"sealed 0444",
			"next: swap per RELEASING.md, then `mailwoman gazetteer build candidate`",
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

export default GazetteerBuildAdmin
