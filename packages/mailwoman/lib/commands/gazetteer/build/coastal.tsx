/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build coastal` — acquire the Environment Agency's National Coastal Erosion Risk
 *   Mapping (England, 2024) and build the sealed `coastal-england.db` layer. Thin wiring only: catalogue read
 *   → download → build → verify all live in `@mailwoman/coastal/sdk`, so each stays unit-testable without Ink
 *   or the network in the loop. Mirrors `flood.tsx`'s progress (stderr) / summary (stdout) split.
 *
 *   `--measure-resolutions` DOES NOT BUILD. The index resolution is a measurement this layer takes rather
 *   than a number argued to, and running the measurement is a mode of its own because it costs a full pass
 *   over the chosen scenarios per candidate and produces a table, not an artifact. The table is PER SCENARIO:
 *   twelve layers cover the same frontages with different extents, and a pooled share would average a
 *   present-day designation together with a 2105 projection and describe neither.
 *
 *   `--scenarios` IS THE SMOKE RUNG, and `--limit` narrows it further. Building one scenario over a real
 *   prefix of the source exercises the field names, the per-layer distance column, the value domains, the
 *   projection and the seal — which is what fixtures structurally cannot.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	formatLayerVerification,
	type ParsedCommandComponent,
	splitList,
	splitNumberList,
	useCommandTask,
} from "#cli-kit"
import { buildSHA as resolveBuildSHA } from "#gazetteer-pipeline/stamp-manifest"

/**
 * Coverage resolution. Res 6 matches what the POI and flood pipelines write, so a reader already keyed to another
 * layer's coverage cells finds these without knowing which build produced them.
 */
const DEFAULT_COVERAGE_RESOLUTION = "6"

/**
 * Index resolution, chosen from the per-scenario `partial`-share measurement — see the workspace README for the table
 * and the reasoning. `--measure-resolutions` re-derives it.
 */
const DEFAULT_INDEX_RESOLUTION = "10"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "coastal",
	description: "Build the Environment Agency coastal-erosion layer (England)",
	options: {
		gdb: { type: "string", description: "Unzipped .gdb directory; downloaded when absent" },
		out: { type: "string", description: "coastal-england.db output path" },
		"index-resolution": { type: "string", default: DEFAULT_INDEX_RESOLUTION, description: "H3 index resolution" },
		"coverage-resolution": {
			type: "string",
			default: DEFAULT_COVERAGE_RESOLUTION,
			description: "H3 coverage resolution",
		},
		"measure-resolutions": { type: "string", description: "Measure the partial share at these resolutions and stop" },
		scenarios: { type: "string", description: "Comma-separated scenario keys (default: all twelve)" },
		limit: { type: "string", description: "Stop each layer's ingest after N features (the smoke rung)" },
		offline: { type: "boolean", default: false, description: "Skip every network read; --gdb required" },
		"source-vintage": { type: "string", description: "Product revision date; read from the catalogue when absent" },
		"chunk-size": { type: "string", description: "Feature ids per ingest process (default 100000)" },
		verify: { type: "boolean", default: false, description: "Run the two-path agreement check after building" },
	},
} as const satisfies CommandSpec

interface Options {
	gdb?: string
	out?: string
	indexResolution: string
	coverageResolution: string
	measureResolutions?: string
	scenarios?: string
	limit?: string
	offline: boolean
	sourceVintage?: string
	chunkSize?: string
	verify: boolean
}

const GazetteerBuildCoastal: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath } = await import("@mailwoman/core/utils")

		const {
			assertAttributionUnchanged,
			buildCoastalDatabase,
			createEANCERMClient,
			createEAServiceReader,
			createGeodatabaseFeatureSource,
			downloadCoastalGeodatabase,
			formatResolutionTotalRows,
			formatScenarioMeasurementRows,
			measureCoastalCellResolutions,
			NCERM_GEODATABASE_RESOURCE,
			sampleAgreementPoints,
			verifyCoastalDatabase,
		} = await import("@mailwoman/coastal/sdk")

		const { DEFAULT_NCERM_SCENARIO, NCERM_SCENARIOS } = await import("@mailwoman/coastal/vocabulary")

		if (options.offline && !options.gdb) {
			throw new Error("gazetteer build coastal: --offline needs --gdb, because the archive cannot be acquired offline")
		}

		const scenarioKeys = options.scenarios
			? splitList(options.scenarios)
			: NCERM_SCENARIOS.map((scenario) => scenario.key)

		const client = createEANCERMClient()

		// The catalogue read supplies the product's ISO revision date AND the direct file URL. Both are read rather than
		// assembled: the EA's file service keys on an opaque id with no relationship to the dataset id, so a hard-coded
		// URL survives a republish by pointing at a file that is no longer the product.
		const catalogue = options.offline ? undefined : await client.readCatalogueRecord()
		const sourceVintage = options.sourceVintage ?? catalogue?.revisionDate

		if (!sourceVintage) {
			throw new Error(
				"gazetteer build coastal: no product vintage — pass --source-vintage, or drop --offline so the catalogue can be read. " +
					"A manifest stamped with a guessed version carries a number that means nothing."
			)
		}

		console.error(`▸ product vintage: ${sourceVintage}`)

		// OGL v3.0 makes the attribution statement a licence CONDITION, so a change in it changes what a re-user has to
		// publish. Read from the structured record and compared against the constant the artifact is stamped with; the
		// abstract's copy is doubled and its first copy carries no year, which is why the parse refuses a yearless one.
		if (!options.offline) {
			assertAttributionUnchanged(await client.readAttributionStatement())
		}

		let geodatabasePath = options.gdb

		if (!geodatabasePath) {
			const url = catalogue?.files[NCERM_GEODATABASE_RESOURCE]

			if (!url) {
				throw new Error(
					`gazetteer build coastal: the catalogue entry names no ${NCERM_GEODATABASE_RESOURCE} resource — pass --gdb`
				)
			}

			geodatabasePath = await downloadCoastalGeodatabase({
				url,
				revisionDate: sourceVintage,
				cacheRoot: String(dataRootPath("coastal", "cache")),
				onProgress: (message) => console.error(`  [download] ${message}`),
			})
		}

		if (options.measureResolutions) {
			const report = await measureCoastalCellResolutions({
				geodatabasePath,
				resolutions: splitNumberList(options.measureResolutions),
				scenarioKeys,
				...(options.limit ? { limit: Number(options.limit) } : {}),
				onProgress: (message) => console.error(`  [measure] ${message}`),
			})

			return [
				`measured ${report.features.toLocaleString()} features across ${scenarioKeys.length} scenario(s)`,
				...formatResolutionTotalRows(report.measurements),
				"",
				...formatScenarioMeasurementRows(report.measurements),
			]
		}

		const coverageResolution = Number(options.coverageResolution)
		const indexResolution = Number(options.indexResolution)
		const out = options.out ?? String(dataRootPath("coastal", "coastal-england.db"))
		const buildSHA = resolveBuildSHA(String(repoRootPath()))

		// The declared count comes from the source's own per-layer totals, so a short read throws rather than building a
		// shorter coastline. A `--limit` run declares the limited total for the same reason.
		const identity = await createGeodatabaseFeatureSource({
			geodatabasePath,
			scenarioKeys,
			...(options.limit ? { limit: Number(options.limit) } : {}),
		})

		console.error(`▸ source declares ${identity.declaredFeatureCount.toLocaleString()} features`)

		// The live service's per-layer feature counts are the cheapest two-path check there is, and they catch a stale or
		// truncated archive before anything is written. PER LAYER rather than pooled: twelve layers of nearly identical
		// size is exactly the population where a pooled total agrees while two of them are transposed. A `--limit` run has
		// deliberately fewer features than the service reports, so the check is skipped there rather than made to pass.
		const expectedFeatureCounts: Record<string, number> = {}

		if (!options.offline && !options.limit) {
			for (const key of scenarioKeys) {
				const layer = `NCERM_${key}`

				expectedFeatureCounts[layer] = await client.readFeatureCount(layer)
			}
		}

		const result = await buildCoastalDatabase({
			// A `--limit` run is the smoke rung and reads a PREFIX in one process; a full build is BATCHED, one child
			// process per scenario layer plus one for the two ground-instability layers. The reason is reproducibility
			// rather than speed — see `@mailwoman/coastal/sdk/ingest-chunk`.
			...(options.limit
				? { source: identity }
				: {
						batched: {
							geodatabasePath,
							scenarioKeys,
							declaredFeatureCount: identity.declaredFeatureCount,
							...(options.chunkSize ? { chunkSize: Number(options.chunkSize) } : {}),
						},
					}),
			out,
			sourceVintage,
			buildCmd: `mailwoman gazetteer build coastal --index-resolution ${indexResolution} --coverage-resolution ${coverageResolution}`,
			buildSHA,
			createdAt: new Date().toISOString(),
			indexResolution,
			coverageResolution,
			...(Object.keys(expectedFeatureCounts).length ? { expectedFeatureCounts } : {}),
			onProgress: (message) => console.error(`  [coastal] ${message}`),
		})

		const lines = [
			`coastal-england.db: ${out} (${await formatFileSize(out)})`,
			`${result.erosionFeatures.toLocaleString()} erosion polygons across ${Object.keys(result.scenarioCounts).length} scenario(s) · ` +
				`${result.instabilityFeatures.toLocaleString()} ground-instability polygons (their own table, never an erosion answer)`,
			`scenarios: ${Object.entries(result.scenarioCounts)
				.map(([scenario, count]) => `${scenario} ${count.toLocaleString()}`)
				.join(" · ")}`,
			`cells: ${result.wholeCellRows.toLocaleString()} whole (compacted per feature) · ${result.partialCellRows.toLocaleString()} partial ` +
				`(${(result.storedPartialShare * 100).toFixed(1)}% of stored rows) · resolutions ${result.storedResolutions.join("/")} · ` +
				`${result.coarsenedFeatures.toLocaleString()} feature(s) coarsened`,
			`coverage: ${result.coverageCells.toLocaleString()} cells at res ${result.coverageResolution}, basis ${result.coverageBasis} — ` +
				"presence only, and NO negative claim: an absent polygon may be inland or coast outside the mapped risk area, and NCERM cannot tell those apart",
			`area: source ${result.area.witness === "source" ? `${result.area.sourceKM2.toFixed(1)} km²` : "not published (no witness)"} · ` +
				`rings with holes ${result.area.nestedKM2.toFixed(1)} km²` +
				`${result.area.witness === "source" ? ` (${(result.area.relativeGap * 100).toFixed(3)}% apart)` : ""} · ` +
				`rings without holes ${result.area.allExteriorKM2.toFixed(1)} km²`,
			`defence types seen: ${result.defenceTypeCounts.length} distinct`,
			`manifest: name=coastal-erosion-ea-england tier=shipped license=OGL-UK-3.0 sourceVintage=${sourceVintage} buildSHA=${buildSHA}`,
		]

		if (options.verify && !options.offline) {
			const points = sampleAgreementPoints(out)

			const verified = await verifyCoastalDatabase({
				databasePath: out,
				readServiceFeatures: createEAServiceReader(client),
				points,
				outsideScenarioKey: scenarioKeys.includes(DEFAULT_NCERM_SCENARIO)
					? DEFAULT_NCERM_SCENARIO
					: (scenarioKeys[0] ?? DEFAULT_NCERM_SCENARIO),
				onProgress: (message) => console.error(`  [verify] ${message}`),
			})

			lines.push(
				...formatLayerVerification(verified, {
					serviceLabel: "the live service",
					outsideLabel: "outside the mapping",
					describeRow: (row) =>
						`  [verify] disagree at ${row.latitude}, ${row.longitude} (${row.label}): artifact ${row.local.kind} via ` +
						`${row.local.containment}, service ${row.serviceInside ? "inside" : "outside"}, ` +
						`${row.nearestEdgeMetres === undefined ? "no nearby polygon" : `${row.nearestEdgeMetres.toFixed(3)} m to nearest edge`}`,
				})
			)
		}

		return lines
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

export default GazetteerBuildCoastal
