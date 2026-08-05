/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build postcode-ni-osm` — the Northern Ireland `BT` unit-postcode shard from
 *   OpenStreetMap. Runs ONE Overpass query, saves the response as the reproducibility artifact, and
 *   writes a sealed shard to a NEW DATED path.
 *
 *   **BUILD-LOCAL TIER.** OSM is ODbL 1.0 and share-alike binds a Derived Database, so this artifact is
 *   never published — not to npm, not to R2, not to the demo. It reaches the resolver only because
 *   `DEFAULT_POSTCODE_SHARDS` is `existsSync`-filtered on the machine that built it.
 *
 *   Coverage is PARTIAL by construction — roughly 9.5 % of live NI postcodes — and that is the point of
 *   shipping it: since #1480 an unknown postcode abstains, so every code the shard carries is a new
 *   answer and every code it lacks behaves exactly as it did before.
 *
 *   The pipeline module is lazy-imported so `--help` never faults without the optional
 *   `@mailwoman/resolver-wof-sqlite` peer.
 */

import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"
import { artifactSizeMB } from "../../../gazetteer-pipeline/index.ts"

const OptionsSchema = zod.object({
	sourceDir: zod
		.string()
		.optional()
		.describe(
			"Acquisition dir for response.json + acquisition.json. Default <data-root>/osm-ni-postcodes/<YYYY-MM-DD>"
		),
	out: zod.string().optional().describe("Output path. Default <data-root>/wof/postalcode-ni-osm-<YYYY-MM-DD>.db"),
	offline: zod
		.boolean()
		.optional()
		.describe("Skip the Overpass query and build from whatever is already in --source-dir (the normal rebuild mode)"),
})

export { OptionsSchema as options }

const GazetteerBuildPostcodeNIOSM: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildPostcodeNIOSM, NI_LIVE_POSTCODES, NI_TOTAL_DISTRICTS, NI_TOTAL_SECTORS } =
			await import("../../../gazetteer-pipeline/postcode/ni-osm-shard.ts")

		const result = await buildPostcodeNIOSM({
			sourceDir: options.sourceDir,
			out: options.out,
			offline: options.offline,
			onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
		})

		const { stats } = result
		const pct = ((result.inserted / NI_LIVE_POSTCODES) * 100).toFixed(1)

		const malformed = Object.entries(stats.malformedValues)
			.map(([value, n]) => `${JSON.stringify(value)}×${n}`)
			.join(", ")

		return [
			`postcode ni-osm: ${result.out} (${artifactSizeMB(result.out)} MB)`,
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
			"next: copy to <data-root>/wof/postalcode-ni-osm.db to activate it (DEFAULT_POSTCODE_SHARDS is existsSync-filtered)",
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

export default GazetteerBuildPostcodeNIOSM
