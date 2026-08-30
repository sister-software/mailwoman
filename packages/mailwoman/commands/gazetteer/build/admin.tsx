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

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "admin",
	description: "Build and verify the global admin gazetteer.",
	options: {
		data: { type: "string", description: "WOF repos root. Default <data-root>/wof/repos" },
		out: { type: "string", description: "Output path. Default <data-root>/wof/admin-global-priority.REBUILD.db" },
		"overture-countries": { type: "string", description: "CSV override of the Overture country set" },
		"geonames-countries": { type: "string", description: "CSV override of the GeoNames country set" },
		"overture-release": { type: "string", description: "Pinned Overture release" },
		"skip-verify": { type: "boolean", default: false, description: "Skip the verify gate (development only)" },
	},
} as const satisfies CommandSpec

interface Options {
	data?: string
	out?: string
	overtureCountries?: string
	geonamesCountries?: string
	overtureRelease?: string
	skipVerify: boolean
}

const csv = (raw: string | undefined): string[] | undefined =>
	raw
		? raw
				.split(",")
				.map((s) => s.trim().toUpperCase())
				.filter((entry) => entry.length > 0)
		: undefined

const GazetteerBuildAdmin: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { artifactSizeMB, buildAdmin } = await import("#gazetteer-pipeline")

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
			`admin gazetteer: ${result.out} (${await artifactSizeMB(result.out)} MB, ${result.elapsedSeconds}s)`,
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
