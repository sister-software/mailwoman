/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `coastal-england.db` — the sealed scenario-scoped polygon layer, from the authority's published
 *   geodatabase.
 *
 *   THE COVERAGE IS `source_present`, AND THAT IS THE WHOLE POINT OF THIS LAYER BEING THE SECOND ONE. The
 *   sibling flood build writes `basis = designated, completeness = 1.0` over the authority's stated England
 *   footprint, because the Planning Practice Guidance defines Zone 1 as the land outside Zones 2 and 3 — an
 *   absence there is a designation. NCERM publishes NO coverage statement, so an absent erosion polygon is
 *   either "inland" or "coast, outside the mapped risk area" and the published layers cannot tell those
 *   apart. A builder that generalized the flood rule would write "no erosion risk" over the whole of England.
 *   So the coverage rows here are exactly the cells the source's own polygons reach, on the weakest basis the
 *   contract has, and {@linkcode assertNoNegativeClaim} refuses anything stronger before a row is written.
 *   `coastal_mapped_extent` stays EMPTY, which is what would have to change first.
 *
 *   THERE IS NO BUILD-TIME TOUCH TABLE, AND ITS ABSENCE IS A CONSEQUENCE OF THE KEY. A flood cell row names a
 *   ZONE CODE, so its containment is not decided until every feature carrying that code has been seen, which
 *   is why that build streams touches into a temporary table and resolves them at the end. An erosion cell
 *   row names ONE POLYGON, so it is final the moment that polygon is classified. The rows go straight in, and
 *   memory stays flat in row count with nothing to resolve afterwards.
 *
 *   THE INGEST IS BOUNDED ANYWAY. h3's WASM heap cannot be reset from JavaScript and does not survive an
 *   unbounded number of polyfill calls; the sibling product died twice on that, after roughly 510,000 and
 *   798,000 features. This product's largest layer holds 7,501, so one chunk per layer fits inside the
 *   100,000-id default with two orders of magnitude to spare — and the bound still ships, because a build
 *   that stays inside a ceiling by luck is not the same fact as one that cannot cross it.
 *
 *   THE AREA CROSS-CHECK IS BELT AND BRACES AND IT STAYS. It costs one subtraction per feature and its
 *   absence is silent: a hole read as an exterior ring produces a well-formed polygon that simply covers
 *   ground the authority did not map, and answers "inside" for every point in it. The zoning survey measured
 *   that at 4.1% over a national layer.
 */

import { readFileSize } from "@mailwoman/core/fs/readers"
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

import { createCoastalTables, type CoastalDatabase } from "#schema"
import type { CoastalFeatureSource } from "#sdk/ingest"
import type { CoastalChunkResult } from "#sdk/ingest-chunk"
import { ingestCoastalChunk } from "#sdk/ingest-chunk"
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
 * Schema version of the domain tables. Bumped when a column changes meaning, never for an added column a reader can
 * ignore.
 */
export const COASTAL_SCHEMA_VERSION = 1

/**
 * Feature ids per chunk process.
 *
 * Sized against the measured ceiling on the sibling product rather than guessed: single-process runs over that layer
 * died after roughly 510,000 and 798,000 features as h3's WASM heap fragmented. NCERM's largest layer holds 7,501
 * features, so this default puts one whole layer in one process. That ceiling makes the build reproducible rather than
 * the fact that this product happens to sit far below it.
 */
export const DEFAULT_CHUNK_SIZE = 100_000

/**
 * Where a build gets its features, and — for a real one — how it bounds each process's share of them.
 */
export type BuildCoastalInput =
	| {
			/**
			 * A feature source consumed IN THIS PROCESS. Correct for a fixture and for anything small; it is what the batched
			 * form falls back to per chunk, so the two share one implementation.
			 */
			source: CoastalFeatureSource
	  }
	| {
			/**
			 * The published geodatabase, ingested in bounded chunks — one child process per scenario layer, plus one for the
			 * two ground-instability layers.
			 */
			batched: {
				geodatabasePath: string
				/**
				 * Which scenarios to build. Defaults to all twelve.
				 */
				scenarioKeys?: ReadonlyArray<string>
				/**
				 * Feature ids per chunk. See {@link DEFAULT_CHUNK_SIZE}.
				 */
				chunkSize?: number
				/**
				 * The feature count the whole build should yield, summed across every layer it reads.
				 */
				declaredFeatureCount: number
			}
	  }

export type BuildCoastalOptions = BuildCoastalInput & {
	/**
	 * Where the sealed artifact lands. The build writes beside it and swaps.
	 */
	out: string
	/**
	 * The product's ISO revision date — `layer_manifest.version` and `source_vintage`.
	 */
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	/**
	 * ISO-8601, supplied by the caller. Never generated here: the contract says so, and a library-generated timestamp
	 * makes two builds of the same inputs differ.
	 */
	createdAt: string
	/**
	 * The resolution the cell index is built at — chosen from the per-scenario `partial`-share measurement.
	 */
	indexResolution: number
	/**
	 * The resolution `layer_coverage` rows are keyed at. Must be coarser than the index resolution.
	 */
	coverageResolution: number
	/**
	 * The feature counts a SECOND distribution channel reports, per layer — the live WFS. Supplied, each is asserted
	 * against what the build streamed for that layer, which is the cheapest two-path check available and catches a stale
	 * or truncated archive.
	 */
	expectedFeatureCounts?: Readonly<Record<string, number>>
	onProgress?: (message: string) => void
}

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
	 * `partialCellRows / (wholeCellRows + partialCellRows)` over the STORED rows — the whole side is compacted per
	 * feature, so this is not the same number the resolution was chosen on and is reported separately.
	 */
	storedPartialShare: number
	/**
	 * Features whose bounding box forced a resolution coarser than `indexResolution`, and the resolutions the stored cell
	 * rows are actually at. Both are reported rather than smoothed over: a reader that assumed one resolution would probe
	 * at the wrong one and read every coarsened feature as an absence.
	 */
	coarsenedFeatures: number
	storedResolutions: number[]
	coverageCells: number
	/**
	 * The basis every coverage row carries. `source_present`, always, while `coastal_mapped_extent` is empty.
	 */
	coverageBasis: CoverageBasis
	/**
	 * The defence types the build saw, with counts — the census a reader checks the closed domain against.
	 */
	defenceTypeCounts: Array<[string, number]>
	/**
	 * The area totals in square kilometres — what the source says, what the encoded rings say read with their holes, and
	 * what they would say read without — with the witness stated.
	 */
	area: AreaAgreementReading
	sizeBytes: number
}

/**
 * The relative gap between the two area readings that fails the build.
 *
 * The comparison is a spherical ring area against GDAL's planar area in the source's own projection, so the two never
 * agree exactly: British National Grid's scale factor runs 0.9996 at its central meridian to about 1.0004 at the edges
 * of its usable zone, contributing roughly a tenth of a percent, and the spherical approximation contributes a similar
 * amount against the ellipsoid. One percent leaves both far inside the tolerance while sitting well below the error a
 * hole-blind read produces — the zoning survey measured that at 4.1% over a whole national layer.
 */
const AREA_TOLERANCE = 0.01

/**
 * Build the layer.
 *
 * @throws {Error} On a value outside the authority's declared domains, a feature that reaches no cell, a feature count
 *   that disagrees with the source's own declaration, an area total that disagrees with the source's, or a coverage row
 *   that would license a negative claim.
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

			// NO SECONDARY INDEXES, AND THAT IS A DECISION RATHER THAN AN OMISSION. Both probes this artifact serves are
			// already primary-key probes: the cell table's `(h3_cell, area_id)` key answers `WHERE h3_cell = ?` as a range
			// scan of a handful of rows, and a scenario filter over those few rows costs nothing; the geometry table is
			// probed by `area_id`, its own key. A `(scenario_key, h3_cell)` index over a `WITHOUT ROWID` table carries the
			// primary key in every entry, so it would roughly double the cell tier to serve a scan that is already short —
			// size for a reader that does not exist.
			const totalCellRows = ingested.wholeCellRows + ingested.partialCellRows

			return {
				out: options.out,
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
 * What the whole ingest produced, however many processes it took.
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
 * Add up what the chunks reported.
 *
 * Exported for its own test: the coverage-cell arithmetic is the one part of the batched path a fixture build cannot
 * reach, and getting it wrong produces a well-formed artifact that under-reports how many polygons a cell holds.
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

		// A coverage cell straddles chunk boundaries — one chunk is one SCENARIO, and every scenario covers the same coast
		// — so the counts ADD rather than replace. Taking the last chunk's value would report a cell as holding only the
		// last scenario's polygons, which is a twelfth of what is there.
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
 * Refuse a scenario whose streamed count disagrees with the live service's.
 *
 * PER SCENARIO RATHER THAN POOLED, because a pooled total can agree while two layers are transposed — twelve layers of
 * nearly identical size is exactly the population where that goes unnoticed.
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
 * Refuse a coverage row that would license a negative claim.
 *
 * THIS IS THE CHECK THE MEANING-OF-ZERO INVERSION TURNS ON. NCERM publishes no coverage statement, so no row of this
 * layer may support an exclusion — a `designated` or `surveyed` basis here would let an absent polygon be read as a
 * designation of safety over the whole of inland England. The reader checks the same thing at open time, so an artifact
 * built by some other path cannot get past it either.
 */
export function assertNoNegativeClaim(cells: ReadonlyArray<CoverageCell>): void {
	assertCoverageNoNegativeClaim("coastal build", cells, NCERM_COVERAGE_LIMIT)
}

/**
 * Run the ingest as a sequence of bounded child processes — one per scenario layer, then one for the two
 * ground-instability layers. The shared chunk contract — the parent's no-handle rule, and the fail-loud handling of a
 * chunk that dies or prints nothing — lives with `ingestChunkArguments` and `runChunkProcess`.
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
			throw new Error(`coastal build: ${JSON.stringify(scenarioKey)} is not one of the twelve published scenarios`)
		}

		// Each layer numbers its own `OBJECTID` from 1, so the range is per layer. The upper bound is deliberately open —
		// `ogrinfo` reports a count, not a maximum id, and a range that stopped at the count would drop every feature past
		// a gap in the numbering.
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
 * Insert the authority's declared domains.
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
