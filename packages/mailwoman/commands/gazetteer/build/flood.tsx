/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build flood` — acquire the Environment Agency's Flood Map for Planning and build
 *   the sealed `flood.db` layer. Thin wiring only: catalogue read → download → extent → build → verify all
 *   live in `@mailwoman/flood/sdk`, so each stays unit-testable without Ink or the network in the loop.
 *   Mirrors `bdc.tsx`'s progress (stderr) / summary (stdout) split.
 *
 *   `--measure-resolutions` DOES NOT BUILD. The index resolution is a measurement this layer takes rather
 *   than a number argued to, and running the measurement is a mode of its own because it costs a full pass
 *   over 813,627 polygons per candidate and produces a table, not an artifact.
 *
 *   `--limit` IS THE SMOKE RUNG. It stops the ingest after N features, which builds a real artifact over a
 *   real prefix of the source — enough to exercise the field names, the value domain, the projection and
 *   the seal, which is what fixtures structurally cannot. The coverage rows still cover all of England,
 *   because the footprint comes from the authority's statement rather than from the polygons.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Coverage resolution. Res 6 matches what the POI pipeline writes, so a reader already keyed to another layer's
 * coverage cells finds these without knowing which build produced them.
 */
const DEFAULT_COVERAGE_RESOLUTION = "6"

/**
 * Index resolution, chosen from the `partial`-share measurement — see the workspace README for the table and the
 * reasoning. `--measure-resolutions` re-derives it.
 */
const DEFAULT_INDEX_RESOLUTION = "9"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "flood",
	description: "Build the Environment Agency flood-zone layer (England)",
	options: {
		gdb: { type: "string", description: "Unzipped .gdb directory; downloaded when absent" },
		out: { type: "string", description: "flood.db output path" },
		"index-resolution": { type: "string", default: DEFAULT_INDEX_RESOLUTION, description: "H3 index resolution" },
		"coverage-resolution": {
			type: "string",
			default: DEFAULT_COVERAGE_RESOLUTION,
			description: "H3 coverage resolution",
		},
		"measure-resolutions": { type: "string", description: "Measure the partial share at these resolutions and stop" },
		limit: { type: "string", description: "Stop the ingest after N features (the smoke rung)" },
		boundary: { type: "string", description: "England outline GeoJSON; fetched from ONS when absent" },
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
	limit?: string
	boundary?: string
	offline: boolean
	sourceVintage?: string
	chunkSize?: string
	verify: boolean
}

const GazetteerBuildFlood: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { execFileSync } = await import("@mailwoman/platform/child_process")

		const { artifactSizeMB } = await import("#gazetteer-pipeline/admin/index")
		const { dataRootPath } = await import("@mailwoman/core/utils")

		const {
			buildFloodDatabase,
			createEAFloodClient,
			createEAServiceReader,
			createGeodatabaseFeatureSource,
			createONSBoundaryClient,
			downloadFloodGeodatabase,
			EA_GEODATABASE_RESOURCE,
			formatResolutionMeasurementRows,
			measureFloodCellResolutions,
			ONS_ENGLAND_PROVENANCE,
			outlineFromGeoJSON,
			readFloodSourceIdentity,
			realizeFloodMapExtent,
			sampleAgreementPoints,
			verifyFloodDatabase,
			EA_COVERAGE_COUNTRY,
		} = await import("@mailwoman/flood/sdk")

		const { EA_COVERAGE_STATEMENT, EA_COVERAGE_STATEMENT_URL } = await import("@mailwoman/flood/vocabulary")

		if (options.offline && !options.gdb) {
			throw new Error("gazetteer build flood: --offline needs --gdb, because the archive cannot be acquired offline")
		}

		const client = createEAFloodClient()

		// The catalogue read supplies the product's ISO revision date AND the direct file URL. Both are read rather than
		// assembled: the EA's file service keys on an opaque id with no relationship to the dataset id, so a hard-coded
		// URL survives a republish by pointing at a file that is no longer the product.
		const catalogue = options.offline ? undefined : await client.readCatalogueRecord()
		const sourceVintage = options.sourceVintage ?? catalogue?.revisionDate

		if (!sourceVintage) {
			throw new Error(
				"gazetteer build flood: no product vintage — pass --source-vintage, or drop --offline so the catalogue can be read. " +
					"A manifest stamped with a guessed version carries a number that means nothing."
			)
		}

		console.error(`▸ product vintage: ${sourceVintage}`)

		let geodatabasePath = options.gdb

		if (!geodatabasePath) {
			const url = catalogue?.files[EA_GEODATABASE_RESOURCE]

			if (!url) {
				throw new Error(
					`gazetteer build flood: the catalogue entry names no ${EA_GEODATABASE_RESOURCE} resource — pass --gdb`
				)
			}

			geodatabasePath = await downloadFloodGeodatabase({
				url,
				revisionDate: sourceVintage,
				cacheRoot: String(dataRootPath("flood", "cache")),
				onProgress: (message) => console.error(`  [download] ${message}`),
			})
		}

		if (options.measureResolutions) {
			const report = await measureFloodCellResolutions({
				geodatabasePath,
				resolutions: options.measureResolutions.split(",").map((value) => Number(value.trim())),
				...(options.limit ? { limit: Number(options.limit) } : {}),
				onProgress: (message) => console.error(`  [measure] ${message}`),
			})

			return [
				`measured ${report.features.toLocaleString()} features`,
				...formatResolutionMeasurementRows(report.measurements),
			]
		}

		// The outline is a SECOND authority's artifact: the EA says its mapping covers all of England and does not publish
		// where England is. Which outline was used rides in `flood_map_extent`.
		const outline = options.boundary
			? outlineFromGeoJSON(await readLocalJSONFile<unknown>(options.boundary), options.boundary)
			: (await createONSBoundaryClient().readCountryGeometry(EA_COVERAGE_COUNTRY)).geometry

		const coverageResolution = Number(options.coverageResolution)
		const indexResolution = Number(options.indexResolution)

		const extent = realizeFloodMapExtent({
			geometry: outline as Parameters<typeof realizeFloodMapExtent>[0]["geometry"],
			coverageResolution,
			authority: "Environment Agency",
			statement: EA_COVERAGE_STATEMENT,
			statementURL: EA_COVERAGE_STATEMENT_URL,
			...(options.boundary
				? { boundary: { ...ONS_ENGLAND_PROVENANCE, source: `local outline: ${options.boundary}`, sourceURL: "" } }
				: {}),
		})

		console.error(
			`▸ footprint: ${extent.coverageCells.size.toLocaleString()} coverage cells at res ${coverageResolution}`
		)

		// The authority's ids run 1..featureCount contiguously, and the batched build walks that range.
		const identity = await readFloodSourceIdentity({ geodatabasePath })

		const out = options.out ?? String(dataRootPath("flood", "flood.db"))
		const buildSHA = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim()

		const result = await buildFloodDatabase({
			// A `--limit` run is the smoke rung and reads a PREFIX in one process; a full build is BATCHED, one child
			// process per range of the authority's own feature ids. The reason is reproducibility rather than speed — see
			// `@mailwoman/flood/sdk/ingest-chunk`.
			...(options.limit
				? {
						source: await createGeodatabaseFeatureSource({ geodatabasePath, limit: Number(options.limit) }),
					}
				: {
						batched: {
							geodatabasePath,
							objectIDFrom: 1,
							objectIDTo: identity.featureCount,
							declaredFeatureCount: identity.featureCount,
							...(options.chunkSize ? { chunkSize: Number(options.chunkSize) } : {}),
						},
					}),
			out,
			sourceVintage,
			buildCmd: `mailwoman gazetteer build flood --index-resolution ${indexResolution} --coverage-resolution ${coverageResolution}`,
			buildSHA,
			createdAt: new Date().toISOString(),
			indexResolution,
			coverageResolution,
			extent,
			// The live service's feature count is the cheapest two-path check there is, and it catches a stale or
			// truncated archive before anything is written. A `--limit` run has deliberately fewer features than the
			// service reports, so the check is skipped there rather than made to pass.
			...(options.offline || options.limit ? {} : { expectedFeatureCount: await client.readFeatureCount() }),
			onProgress: (message) => console.error(`  [flood] ${message}`),
		})

		const lines = [
			`flood.db: ${out} (${await artifactSizeMB(out)} MB)`,
			`${result.features.toLocaleString()} polygons · ${Object.entries(result.zoneCounts)
				.map(([zone, count]) => `${zone} ${count.toLocaleString()}`)
				.join(" · ")}`,
			`cells: ${result.wholeCellRows.toLocaleString()} whole (compacted) · ${result.partialCellRows.toLocaleString()} partial ` +
				`(${(result.storedPartialShare * 100).toFixed(1)}% of stored rows) · ${result.candidateRows.toLocaleString()} candidate pairs ` +
				`· resolutions ${result.storedResolutions.join("/")} · ${result.coarsenedFeatures.toLocaleString()} feature(s) coarsened`,
			`coverage: ${result.coverageCells.toLocaleString()} cells at res ${result.coverageResolution}, ` +
				`${result.coverageCellsWithRows.toLocaleString()} holding a polygon, ` +
				`${(result.coverageCells - result.coverageCellsWithRows).toLocaleString()} designated-absence (Zone 1)`,
			`area: source ${result.area.sourceKM2.toFixed(1)} km² · rings with holes ${result.area.nestedKM2.toFixed(1)} km² ` +
				`(${(result.area.relativeGap * 100).toFixed(3)}% apart) · rings without holes ${result.area.allExteriorKM2.toFixed(1)} km²`,
			`manifest: name=flood-zones-ea-england tier=shipped license=OGL-UK-3.0 sourceVintage=${sourceVintage} buildSHA=${buildSHA}`,
		]

		if (options.verify && !options.offline) {
			const points = sampleAgreementPoints(out)

			const verified = await verifyFloodDatabase({
				databasePath: out,
				readServiceFeatures: createEAServiceReader(client),
				points,
				onProgress: (message) => console.error(`  [verify] ${message}`),
			})

			// A disagreement count is not actionable on its own — the rows are. Printed to stderr with the progress stream,
			// because the first thing anyone does with a non-zero count is ask which points.
			for (const row of verified.agreement.filter((entry) => entry.outcome === "disagree")) {
				console.error(
					`  [verify] disagree at ${row.latitude}, ${row.longitude} (${row.label}): artifact ${row.local.kind}` +
						`${row.local.zoneCode ? ` ${row.local.zoneCode}` : ""} via ${row.local.containment}, service ${row.service ?? "no zone"}`
				)
			}

			lines.push(
				`verify: ${verified.agreed}/${verified.agreement.length} agree with the live service · ` +
					`${verified.boundaryTolerance} within boundary tolerance · ${verified.disagreed} disagree`,
				`verify (outside England): ${verified.outsidePassed}/${verified.outside.length} read unknown, ` +
					`${
						verified.outside
							.filter((row) => !row.passed)
							.map((row) => row.label)
							.join(", ") || "none read a zone"
					}`
			)
		}

		return lines
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

export default GazetteerBuildFlood
