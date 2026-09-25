/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the sealed `coastal-england.db` from the Environment Agency's NCERM geodatabase.
 *
 *   NCERM publishes no coverage statement, so a point without an erosion polygon may be inland or on
 *   an unmapped coast. Coverage rows therefore use the `source_present` basis and cover only the cells
 *   the polygons reach. {@linkcode assertNoNegativeClaim} rejects any stronger basis.
 *
 *   Each cell row refers to one polygon, so rows are final when written and need no resolve pass.
 *   The ingest still runs in bounded child processes because h3's wasm heap cannot be reset and fails
 *   after enough polyfill calls. The area cross-check catches a hole read as an exterior ring, which
 *   would otherwise cover ground the source did not map.
 */

import { readFileSize } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import {
	areaAgreementFrom,
	assertAreaAgreement,
	assertNoNegativeClaim as assertCoverageNoNegativeClaim,
	createLayerCoverageTable,
	createLayerManifestTable,
	polygonLayerManifest,
	sourcePresentCoverageCells,
	writeLayerCoverage,
	writeLayerManifest,
	type AreaAgreementReading,
	type CoverageCell,
} from "@mailwoman/core/layers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { ingestChunkArguments, mergeCountsInto, runChunkProcess } from "@mailwoman/core/utils"
import { CoverageBasis } from "@mailwoman/evidence"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed-build"
import type { PathBuilderLike } from "path-ts"

import { createCoastalTables, type CoastalDatabase } from "#schema"
import type { CoastalChunkResult } from "#sdk/ingest/chunk"
import { ingestCoastalChunk } from "#sdk/ingest/chunk"
import type { CoastalFeatureSource } from "#sdk/ingest/index"
import {
	NCERM_ATTRIBUTION,
	NCERM_COVERAGE_LIMIT,
	NCERM_DATASET_ID,
	NCERM_DEFENCE_TYPES_FOLDED,
	NCERM_LAYER_NAME,
	NCERM_LICENSE,
	NCERM_POLICY_INTERPRETATIONS,
	NCERM_POLICY_VALUES,
	NCERM_SCENARIO_TERMS,
	NCERM_SCENARIOS,
	NCERM_SCENARIOS_BY_KEY,
	NCERM_DATASET_URL,
} from "#vocabulary"

/**
 * Schema version of the domain tables.
 *
 * Bump it when a column changes meaning.
 * An added column that readers can ignore needs no bump.
 */
export const COASTAL_SCHEMA_VERSION = 1

/**
 * Feature IDs per chunk process.
 *
 * The flood build's h3 heap failed after roughly 510,000 features in one process,
 * so each chunk stays well below that.
 * Every NCERM layer fits in one chunk at this size.
 */
export const DEFAULT_CHUNK_SIZE = 100_000

/**
 * Feature source for a build: an in-process source, or the geodatabase ingested in child processes.
 */
export type BuildCoastalInput =
	| {
			/**
			 * A feature source read in this process, for fixtures and small inputs.
			 */
			source: CoastalFeatureSource
	  }
	| {
			/**
			 * The published geodatabase, ingested with one child process per scenario layer
			 * and one more for the two ground-instability layers.
			 */
			batched: {
				geodatabasePath: string
				/**
				 * Scenarios to build.
				 * Defaults to all of them.
				 */
				scenarioKeys?: ReadonlyArray<string>
				/**
				 * Feature IDs per chunk.
				 * Defaults to {@link DEFAULT_CHUNK_SIZE}.
				 */
				chunkSize?: number
				/**
				 * The expected feature count summed across every layer the build reads.
				 */
				declaredFeatureCount: number
			}
	  }

/**
 * Options for {@link buildCoastalDatabase}.
 */
export type BuildCoastalOptions = BuildCoastalInput & {
	/**
	 * Destination of the sealed database.
	 * The build writes beside it and then swaps it into place.
	 */
	out: PathBuilderLike
	/**
	 * The product's ISO revision date, stored as the manifest version and source vintage.
	 */
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	/**
	 * ISO-8601 creation time from the caller, so that identical inputs produce identical builds.
	 */
	createdAt: string
	/**
	 * H3 resolution of the cell index.
	 */
	indexResolution: number
	/**
	 * H3 resolution of the `layer_coverage` rows.
	 * It must be coarser than the index resolution.
	 */
	coverageResolution: number
	/**
	 * Per-layer feature counts from the live WFS.
	 *
	 * The build checks each layer's streamed count against them, which catches a stale or truncated archive.
	 */
	expectedFeatureCounts?: Readonly<Record<string, number>>
	onProgress?: (message: string) => void
}

/**
 * Counts and checks from a {@link buildCoastalDatabase} run.
 */
export interface BuildCoastalResult {
	out: string
	erosionFeatures: number
	instabilityFeatures: number
	scenarioCounts: Record<string, number>
	indexResolution: number
	coverageResolution: number
	wholeCellRows: number
	partialCellRows: number
	/**
	 * `partialCellRows / (wholeCellRows + partialCellRows)` over the stored rows.
	 *
	 * Whole cells are compacted, so this share differs from the pre-compaction share.
	 */
	storedPartialShare: number
	/**
	 * Number of features whose size forced a resolution coarser than `indexResolution`.
	 */
	coarsenedFeatures: number
	/**
	 * Every resolution present in the stored cell rows.
	 * A reader must probe all of them.
	 */
	storedResolutions: number[]
	coverageCells: number
	/**
	 * The basis of every coverage row, which is `source_present` while `coastal_mapped_extent` is empty.
	 */
	coverageBasis: CoverageBasis
	/**
	 * Defence types seen during the build, with counts.
	 */
	defenceTypeCounts: Array<[string, number]>
	/**
	 * Area totals from the source and from the encoded rings, read with and without holes.
	 */
	area: AreaAgreementReading
	sizeBytes: number
}

/**
 * Relative gap between the source area and the ring area that fails the build.
 *
 * The ring area is spherical and the source area is planar in British National Grid,
 * so they differ by a few tenths of a percent.
 * Reading holes as exterior rings produces a gap of several percent.
 */
const AREA_TOLERANCE = 0.01

/**
 * Build and seal `coastal-england.db`.
 *
 * @throws {Error} On a value outside the source's declared domains, a feature that
 * reaches no cell, a feature count or area total that disagrees with the source,
 * or a coverage row that would support a negative claim.
 */
export async function buildCoastalDatabase(options: BuildCoastalOptions): Promise<BuildCoastalResult> {
	if (options.coverageResolution >= options.indexResolution) {
		throw new Error(
			`coastal build: the coverage resolution (${options.coverageResolution}) must be coarser than the index resolution (${options.indexResolution}) — a row's coverage cell is the PARENT of its index cell`
		)
	}

	const batched = "batched" in options ? options.batched : undefined
	const source = "batched" in options ? undefined : options.source
	const declaredFeatureCount = batched ? batched.declaredFeatureCount : source!.declaredFeatureCount

	options.onProgress?.(
		batched
			? `source: ${batched.geodatabasePath} · ${declaredFeatureCount.toLocaleString()} features`
			: `source: EPSG:${source!.epsg} · ${declaredFeatureCount.toLocaleString()} features · ${source!.origin}`
	)

	const built = await buildSealedArtifact<CoastalDatabase, StreamResult, Omit<BuildCoastalResult, "sizeBytes">>({
		out: options.out,
		createTables: async (kdb) => {
			await createCoastalTables(kdb)
			await createLayerManifestTable(kdb)
			await createLayerCoverageTable(kdb)
		},
		ingest: async (kdb) => {
			if (!source) return undefined

			return aggregateChunks([
				await ingestCoastalChunk(kdb, {
					source,
					indexResolution: options.indexResolution,
					coverageResolution: options.coverageResolution,
					...(options.onProgress ? { onProgress: options.onProgress } : {}),
				}),
			])
		},
		...(batched ? { batched: (tmpPath: string) => runBatchedIngest(tmpPath, options, batched) } : {}),
		finish: async (kdb, ingested) => {
			const totalFeatures = ingested.erosionFeatures + ingested.instabilityFeatures

			if (totalFeatures !== declaredFeatureCount) {
				throw new Error(
					`coastal build: streamed ${totalFeatures} features, the source declares ${declaredFeatureCount} — a short read builds a shorter coastline and reports success`
				)
			}

			assertScenarioCounts(ingested.scenarioCounts, options.expectedFeatureCounts)
			assertAreaAgreement("coastal build", ingested.area, AREA_TOLERANCE)

			options.onProgress?.(
				`${ingested.erosionFeatures.toLocaleString()} erosion features · ${ingested.instabilityFeatures.toLocaleString()} ground-instability features written`
			)

			const coverage = sourcePresentCoverageCells(ingested.observedByCoverageCell)

			assertNoNegativeClaim(coverage)

			await writeLayerCoverage(kdb, coverage)

			writeVocabularyRows(kdb)

			await writeLayerManifest(
				kdb,
				polygonLayerManifest(options, {
					name: NCERM_LAYER_NAME,
					schemaVersion: COASTAL_SCHEMA_VERSION,
					license: NCERM_LICENSE,
					attribution: NCERM_ATTRIBUTION,
					source: `environment.data.gov.uk/dataset/${NCERM_DATASET_ID}`,
					cellColumn: "coastal_zone_cell.h3_cell",
				})
			)

			const storedResolutions = (
				kdb.prepare("SELECT DISTINCT resolution FROM coastal_zone_cell ORDER BY resolution").all() as Array<{
					resolution: number
				}>
			).map((row) => row.resolution)

			// The tables need no secondary indexes because both reader probes use primary keys.
			// A `(scenario_key, h3_cell)` index would roughly double the cell table.
			const totalCellRows = ingested.wholeCellRows + ingested.partialCellRows

			return {
				out: options.out.toString(),
				erosionFeatures: ingested.erosionFeatures,
				instabilityFeatures: ingested.instabilityFeatures,
				scenarioCounts: ingested.scenarioCounts,
				indexResolution: options.indexResolution,
				coverageResolution: options.coverageResolution,
				wholeCellRows: ingested.wholeCellRows,
				partialCellRows: ingested.partialCellRows,
				storedPartialShare: totalCellRows ? ingested.partialCellRows / totalCellRows : 0,
				coarsenedFeatures: ingested.coarsened,
				storedResolutions,
				coverageCells: coverage.length,
				coverageBasis: CoverageBasis.SourcePresent,
				defenceTypeCounts: ingested.defenceTypeCounts,
				area: ingested.area,
			}
		},
	})

	return { ...built, sizeBytes: await readFileSize(options.out) }
}

/**
 * Totals from the whole ingest across all chunk processes.
 */
interface StreamResult {
	erosionFeatures: number
	instabilityFeatures: number
	coarsened: number
	scenarioCounts: Record<string, number>
	wholeCellRows: number
	partialCellRows: number
	observedByCoverageCell: Map<number, number>
	defenceTypeCounts: Array<[string, number]>
	area: AreaAgreementReading
}

/**
 * Sum the results of every chunk.
 *
 * It is exported for testing because a fixture build never exercises the batched path.
 */
export function aggregateChunks(chunks: ReadonlyArray<CoastalChunkResult>): StreamResult {
	const scenarioCounts: Record<string, number> = {}
	const defenceTypeCounts = new Map<string, number>()
	const observedByCoverageCell = new Map<number, number>()

	let erosionFeatures = 0
	let instabilityFeatures = 0
	let coarsened = 0
	let wholeCellRows = 0
	let partialCellRows = 0
	let sourceArea = 0
	let nestedArea = 0
	let allExteriorArea = 0

	for (const chunk of chunks) {
		erosionFeatures += chunk.erosionFeatures
		instabilityFeatures += chunk.instabilityFeatures
		coarsened += chunk.coarsened
		wholeCellRows += chunk.wholeCellRows
		partialCellRows += chunk.partialCellRows
		sourceArea += chunk.area.sourceM2
		nestedArea += chunk.area.nestedM2
		allExteriorArea += chunk.area.allExteriorM2

		for (const [scenario, count] of Object.entries(chunk.scenarioCounts)) {
			scenarioCounts[scenario] = (scenarioCounts[scenario] ?? 0) + count
		}

		mergeCountsInto(defenceTypeCounts, chunk.defenceTypeCounts)

		// Every scenario chunk covers the same coast, so coverage counts from different chunks add up.
		mergeCountsInto(observedByCoverageCell, chunk.observedByCoverageCell)
	}

	return {
		erosionFeatures,
		instabilityFeatures,
		coarsened,
		scenarioCounts,
		wholeCellRows,
		partialCellRows,
		observedByCoverageCell,
		defenceTypeCounts: [...defenceTypeCounts].toSorted((left, right) => right[1] - left[1]),
		area: areaAgreementFrom({ nestedM2: nestedArea, allExteriorM2: allExteriorArea }, sourceArea),
	}
}

/**
 * Throw when a scenario's streamed feature count differs from the live service's count.
 *
 * The check runs per scenario because a pooled total could match while two layers are swapped.
 */
function assertScenarioCounts(
	streamed: Readonly<Record<string, number>>,
	expected: Readonly<Record<string, number>> | undefined
): void {
	if (!expected) return

	for (const [layer, count] of Object.entries(expected)) {
		const key = layer.replace(/^NCERM_/u, "")
		const built = streamed[key]

		if (built === undefined) continue

		if (built !== count) {
			throw new Error(
				`coastal build: ${layer} streamed ${built} features and the live service reports ${count} — the archive is a different vintage from the one the service is publishing`
			)
		}
	}
}

/**
 * Throw on any coverage row whose basis would support a negative claim.
 *
 * NCERM publishes no coverage statement, so a stronger basis would mark inland England as safe.
 * The reader repeats this check when it opens a database.
 */
export function assertNoNegativeClaim(cells: ReadonlyArray<CoverageCell>): void {
	assertCoverageNoNegativeClaim("coastal build", cells, NCERM_COVERAGE_LIMIT)
}

/**
 * Run the ingest as bounded child processes, one per scenario layer chunk
 * and one for the ground-instability layers.
 */
async function runBatchedIngest(
	tmpPath: string,
	options: BuildCoastalOptions,
	batched: Extract<BuildCoastalInput, { batched: unknown }>["batched"]
): Promise<StreamResult> {
	const chunkSize = batched.chunkSize ?? DEFAULT_CHUNK_SIZE
	const script = resolveModulePath("@mailwoman/coastal/scripts/ingest-chunk")
	const chunks: CoastalChunkResult[] = []

	const scenarioKeys = batched.scenarioKeys ?? NCERM_SCENARIOS.map((scenario) => scenario.key)

	for (const scenarioKey of scenarioKeys) {
		const scenario = NCERM_SCENARIOS_BY_KEY.get(scenarioKey)

		if (!scenario) {
			throw new Error(`coastal build: ${stringifyJSON(scenarioKey)} is not one of the twelve published scenarios`)
		}

		// Each layer numbers `objectid` from 1.
		// The loop stops at the first empty chunk instead of at the feature count,
		// because gaps in the numbering would otherwise drop features.
		let from = 1

		for (;;) {
			const to = from + chunkSize - 1

			options.onProgress?.(`chunk ${scenario.layer} OBJECTID ${from}–${to}`)

			const result = await runChunkProcess<CoastalChunkResult>({
				script,
				context: "coastal build",
				args: ingestChunkArguments({
					database: tmpPath,
					args: [
						"--gdb",
						batched.geodatabasePath,
						"--scenario",
						scenarioKey,
						"--object-id-from",
						String(from),
						"--object-id-to",
						String(to),
					],
					indexResolution: options.indexResolution,
					coverageResolution: options.coverageResolution,
				}),
			})

			chunks.push(result)

			if (!result.erosionFeatures) break

			from = to + 1
		}
	}

	options.onProgress?.("chunk ground instability")

	chunks.push(
		await runChunkProcess<CoastalChunkResult>({
			script,
			context: "coastal build",
			args: ingestChunkArguments({
				database: tmpPath,
				args: ["--gdb", batched.geodatabasePath, "--instability"],
				indexResolution: options.indexResolution,
				coverageResolution: options.coverageResolution,
			}),
		})
	)

	return aggregateChunks(chunks)
}

/**
 * Insert the source's declared value domains into the vocabulary table.
 */
function writeVocabularyRows(database: DatabaseClient<CoastalDatabase>): void {
	const insert = database.prepare(
		"INSERT INTO coastal_scenario_vocabulary (field, value, label, definition, definition_url) VALUES (?, ?, ?, ?, ?)"
	)

	for (const term of NCERM_SCENARIO_TERMS) {
		insert.run("scenario_key", term.value, term.label, term.definition, term.definitionURL)
	}

	for (const term of NCERM_POLICY_INTERPRETATIONS) {
		insert.run("policy_interpretation", term.value, term.label, term.definition, term.definitionURL)
	}

	for (const policy of NCERM_POLICY_VALUES) {
		insert.run(
			"policy",
			policy,
			policy === " " ? "blank" : policy,
			"A shoreline management policy the Environment Agency publishes for a frontage, carried verbatim. The two policy fields disagree on the spacing around one slash, and both spellings are held.",
			NCERM_DATASET_URL
		)
	}

	for (const defence of NCERM_DEFENCE_TYPES_FOLDED) {
		insert.run(
			"defence_type",
			defence,
			defence === " " ? "blank" : defence,
			"A coastal defence type the Environment Agency publishes for a frontage, in its case-folded comparison form. The stored value on a row is the source's own spelling.",
			NCERM_DATASET_URL
		)
	}
}
