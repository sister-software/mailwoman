/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build postcode-ni-osm` — the Northern Ireland `BT` unit-postcode database from
 *   OpenStreetMap. Runs ONE Overpass query, saves the response as the reproducibility artifact, and
 *   writes a sealed database to a NEW DATED path.
 *
 *   **BUILD-LOCAL TIER.** OSM is ODbL 1.0 and share-alike binds a Derived Database, so this artifact is
 *   never published — not to npm, not to R2, not to the demo. It reaches the resolver only because
 *   `DEFAULT_POSTCODE_DATABASES` is `existsSync`-filtered on the machine that built it.
 *
 *   Coverage is PARTIAL by construction — roughly 9.5 % of live NI postcodes — and that is the point of
 *   shipping it: since #1480 an unknown postcode abstains, so every code the database carries is a new
 *   answer and every code it lacks behaves exactly as it did before.
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
	name: "postcode-ni-osm",
	description: "Build the local Northern Ireland OSM postcode database.",
	options: {
		"source-dir": { type: "string", description: "Acquisition directory" },
		out: { type: "string", description: "Output path" },
		offline: { type: "boolean", description: "Build from existing acquisition files" },
	},
} as const satisfies CommandSpec

interface Options {
	sourceDir?: string
	out?: string
	offline?: boolean
}

const GazetteerBuildPostcodeNIOSM: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildPostcodeNIOSM, NI_LIVE_POSTCODES, NI_TOTAL_DISTRICTS, NI_TOTAL_SECTORS } =
			await import("#gazetteer/postcode/ni-osm-database")

		const result = await buildPostcodeNIOSM({
			sourceDir: options.sourceDir,
			out: options.out,
			offline: options.offline,
			onPhase: phaseReporter(),
		})

		const { stats } = result
		const pct = ((result.inserted / NI_LIVE_POSTCODES) * 100).toFixed(1)

		const malformed = Object.entries(stats.malformedValues)
			.map(([value, n]) => `${JSON.stringify(value)}×${n}`)
			.join(", ")

		return [
			`postcode ni-osm: ${result.out} (${await formatFileSize(result.out)})`,
			`${result.inserted.toLocaleString()} unit postcodes — OSM data cut ${result.osmTimestamp}`,
			`read ${stats.elements.toLocaleString()} elements (${Object.entries(stats.pointsByType)
				.map(([type, n]) => `${n.toLocaleString()} ${type}`)
				.join(" · ")}) · dropped ${stats.skippedMalformed} malformed${malformed ? ` [${malformed}]` : ""} · ${
				stats.skippedNoCoordinate
			} no-coordinate`,
			`coverage ${result.inserted.toLocaleString()}/${NI_LIVE_POSTCODES.toLocaleString()} live NI postcodes (${pct} %) · ` +
				`${result.sectors}/${NI_TOTAL_SECTORS} sectors · ${result.districts}/${NI_TOTAL_DISTRICTS} districts`,
			`reconciliation — ${
				!result.reconciliationFailures.length
					? "every identity holds"
					: `FAILURES: ${result.reconciliationFailures.join(" · ")}`
			}`,
			`fts ${result.ftsRows.toLocaleString()} · bbox ${result.bboxRows.toLocaleString()} · ancestors ${result.ancestorRows.toLocaleString()}`,
			`response md5 ${result.responseMD5} · query md5 ${result.queryMD5}`,
			"a miss on a BT code means NOT ATTESTED IN OSM — not that the postcode does not exist (see meta.coverage_meaning_of_zero)",
			"licence: ODbL 1.0 — BUILD-LOCAL, never published to npm/R2/demo; attribution in the `meta` table",
			"sealed 0444",
			"next: copy to <data-root>/wof/postalcode-ni-osm.db to activate it (DEFAULT_POSTCODE_DATABASES is existsSync-filtered)",
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

export default GazetteerBuildPostcodeNIOSM
