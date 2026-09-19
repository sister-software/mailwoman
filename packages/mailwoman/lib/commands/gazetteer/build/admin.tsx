/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build admin` — the turnkey admin-gazetteer build: WOF ingest → Overture
 *   divisions (real `division_area` extents + country nodes, #1015) → GeoNames folds → freeze →
 *   enrich (region abbrevs + place_abbr) → FTS → the structural verify check (#1026 node census,
 *   reverse EU panel) → seal 0444. Builds to a staging path. swapping over the live DB is a separate,
 *   deliberate step (releasing.md). The coverage recipe lives in `gazetteer-pipeline/defaults.ts`.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers"
import { Box, Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	phaseReporter,
	splitCountryCodes,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
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
		"skip-verify": { type: "boolean", default: false, description: "Skip the verify check (development only)" },
	},
} as const satisfies CommandSpec

const csv = (raw: string | undefined): string[] | undefined => (raw ? splitCountryCodes(raw) : undefined)

const GazetteerBuildAdmin: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildAdmin } = await import("#gazetteer-pipeline")

		const result = await buildAdmin({
			dataDir: options.data,
			out: options.out,
			overtureCountries: csv(options.overtureCountries),
			geonamesCountries: csv(options.geonamesCountries),
			overtureRelease: options.overtureRelease,
			skipVerify: options.skipVerify,
			onPhase: phaseReporter(),
		})

		return [
			`admin gazetteer: ${result.out} (${await formatFileSize(result.out)}, ${result.elapsedSeconds}s)`,
			`${result.placesIngested.toLocaleString()} WOF + ${result.overtureIngested.toLocaleString()} overture + ${result.geonamesIngested.toLocaleString()} geonames`,
			result.verify ? `verify: PASS (${result.verify.checks.length} checks)` : "verify: SKIPPED (--skip-verify)",
			"sealed 0444",
			"next: swap per RELEASING.md, then `mailwoman gazetteer build candidate`",
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

export default GazetteerBuildAdmin
