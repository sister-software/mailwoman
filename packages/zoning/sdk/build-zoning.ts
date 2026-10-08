/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Build `zoning-ireland.db`, the sealed two-tier polygon layer. Its coverage basis and license tier can each refuse publication.
 */

import { readFileSize } from "@mailwoman/core/fs/readers/stat"
import { stringifyJSON } from "@mailwoman/core/json"
import {
	areaAgreementFrom,
	assertNoNegativeClaim as assertCoverageNoNegativeClaim,
	assertTierMatchesLicense,
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerTier,
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
import { M2_PER_KM2 } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed/build"
import type { PathBuilderLike } from "path-ts"

import { createZoningTables, type ZoningDatabase } from "#schema"
import type { ZoningFeatureSource } from "#sdk/ingest"
import type { CrosswalkPair, ObservedTerm, ZoningChunkResult } from "#sdk/ingest/chunk"
import { ingestZoningChunk } from "#sdk/ingest/chunk"
import {
	GZT_ATTRIBUTION,
	GZT_COVERAGE_LIMIT,
	GZT_CROSSWALK_SCHEME,
	GZT_DECLARED_CODES,
	GZT_DECLARED_CODE_SET,
	GZT_ITEM_ID,
	GZT_LAYER_NAME,
	GZT_LICENSE,
	GZT_LICENSE_CONTRADICTION,
	GZT_PLAN_LEVELS,
} from "#vocabulary"

/**
 * Schema version of the domain tables, bumped when a column changes meaning
 * rather than for an added column a reader can ignore.
 */
export const ZONING_SCHEMA_VERSION = 1

/**
 * The plan-level vocabulary scheme.
 */
export const PLAN_LEVEL_SCHEME = "IE-PLAN-LEVEL"

/**
 * Feature ids per chunk process, bounded at 100,000 because h3's wasm heap cannot be
 * reset from JavaScript and does not survive an unbounded number of polyfill calls.
 */
export const DEFAULT_CHUNK_SIZE = 100_000

/**
 * Where a build gets its features.
 * A real build also bounds each process's share of them.
 */
export type BuildZoningInput =
	| {
			/**
			 * A feature source consumed in this process.
			 * It is the per-chunk fallback of the batched form.
			 */
			source: ZoningFeatureSource
	  }
	| {
			/**
			 * The bulk export, ingested in bounded chunks — one child process per range
			 * of the authority's own feature ids.
			 */
			batched: {
				exportPath: string

				chunkSize?: number

				declaredFeatureCount: number
			}
	  }

export type BuildZoningOptions = BuildZoningInput & {
	/**
	 * Where the sealed artifact lands.
	 * The build writes beside it and swaps.
	 */
	out: PathBuilderLike
	/**
	 * The product vintage — `layer_manifest.version` and `source_vintage`.
	 */
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	/**
	 * ISO-8601, supplied by the caller so two builds of the same inputs do not differ.
	 */
	createdAt: string
	/**
	 * The resolution the cell index is built at — chosen from the candidates-per-cell
	 * and zero-cell measurement.
	 */
	indexResolution: number
	/**
	 * The resolution used for `layer_coverage` row keys.
	 * It must be coarser than the index resolution.
	 */
	coverageResolution: number
	/**
	 * The publisher's own `Shape__Area` sum in square meters, read from the live service.
	 *
	 * When supplied, the build asserts that its encoded rings agree with this value.
	 */
	expectedSourceAreaM2?: number
	/**
	 * The feature count the live service reports.
	 *
	 * When supplied, the build asserts its streamed total against this value.
	 */
	expectedFeatureCount?: number
	/**
	 * The tier to stamp, `build-local` unless the license contradiction is resolved —
	 * see {@link assertTierMatchesLicense}.
	 */
	tier?: LayerTier
	onProgress?: (message: string) => void
}

export interface BuildZoningResult {
	out: string
	features: number
	jurisdictions: number
	plans: number
	indexResolution: number
	coverageResolution: number
	wholeCellRows: number
	partialCellRows: number
	/**
	 * The partial share over the stored rows.
	 *
	 * This differs from the share used to choose the resolution because the whole
	 * side is compacted per feature.
	 */
	storedPartialShare: number
	/**
	 * Features forced coarser than `indexResolution`, and the resolutions the stored
	 * cell rows are actually at, reported rather than smoothed over.
	 */
	coarsenedFeatures: number
	storedResolutions: number[]
	coverageCells: number
	/**
	 * The basis stored in every coverage row, `source_present` while `zoning_mapped_extent` is empty.
	 */
	coverageBasis: CoverageBasis
	tier: LayerTier
	license: string
	/**
	 * The ring-role census records the total rings and the exteriors and holes inferred from orientation.
	 *
	 * It also counts holes placed on their parent's boundary rather than inside it.
	 */
	rings: {
		total: number
		exteriors: number
		holes: number
		nestedHoles: number
		adjacentHoles: number
		/**
		 * Features whose exterior was chosen by magnitude because no ring read as one
		 * by orientation, reported rather than implied to be zero.
		 */
		exteriorByMagnitude: number
	}
	/**
	 * The area totals in square kilometers with the witness stated, never defaulting
	 * the publisher's figure to this build's own reading.
	 */
	area: AreaAgreementReading & { signedKM2: number }
	/**
	 * The vocabulary census, per scheme: how many codes the artifact holds
	 * and how many of them the publisher never declared.
	 */
	vocabulary: Array<{ scheme: string; codes: number; undeclared: number; undeclaredCodes: string[] }>
	/**
	 * (authority, local code) pairs and how many take more than one generic type,
	 * the measurement that keeps `zoning_crosswalk_edge` empty.
	 */
	crosswalk: {
		pairs: number
		nonFunctionalPairs: number

		worst: Array<{ authorityCode: string; localCode: string; crosswalkCodes: string[] }>
	}
	sizeBytes: number
}

/**
 * The relative gap between the two area readings that fails the build,
 * set below the 4.1% a hole-blind read produces.
 */
const AREA_TOLERANCE = 0.01

const WORST_PAIRS_REPORTED = 8

/**
 * Build the layer.
 *
 * @throws {Error} On a feature that reaches no cell, a feature count that disagrees
 * with the source's own declaration, an area total that disagrees with the publisher's,
 * a coverage row that would license a negative claim, a crosswalk edge table written while
 * the mapping is not a function, or a `shipped` tier asked for under an unresolved license.
 */
export async function buildZoningDatabase(options: BuildZoningOptions): Promise<BuildZoningResult> {
	const tier = options.tier ?? LayerTier.BuildLocal

	assertTierMatchesLicense(
		{ tier, license: GZT_LICENSE },
		"zoning build",
		`${GZT_LICENSE_CONTRADICTION} Resolve the grant in writing first, then change the tier.`
	)

	if (options.coverageResolution >= options.indexResolution) {
		throw new Error(
			`zoning build: the coverage resolution (${options.coverageResolution}) must be coarser than the index resolution (${options.indexResolution}) — a row's coverage cell is the PARENT of its index cell`
		)
	}

	const batched = "batched" in options ? options.batched : undefined
	const source = "batched" in options ? undefined : options.source
	const declaredFeatureCount = batched ? batched.declaredFeatureCount : source!.declaredFeatureCount

	options.onProgress?.(
		batched
			? `source: ${batched.exportPath} · ${declaredFeatureCount.toLocaleString()} features`
			: `source: EPSG:${source!.epsg} · ${declaredFeatureCount.toLocaleString()} features · ${source!.origin}`
	)

	const built = await buildSealedArtifact<ZoningDatabase, StreamResult, Omit<BuildZoningResult, "sizeBytes">>({
		out: options.out,
		createTables: async (kdb) => {
			await createZoningTables(kdb)
			await createLayerManifestTable(kdb)
			await createLayerCoverageTable(kdb)
		},
		ingest: async (kdb) => {
			if (!source) return null

			return aggregateChunks([
				await ingestZoningChunk(kdb, {
					source,
					indexResolution: options.indexResolution,
					coverageResolution: options.coverageResolution,
					...(options.onProgress ? { onProgress: options.onProgress } : {}),
				}),
			])
		},
		...(batched ? { batched: (tmpPath: string) => runBatchedIngest(tmpPath, options, batched) } : {}),
		finish: async (kdb, ingested) => buildZoningResult(kdb, options, tier, declaredFeatureCount, ingested),
	})

	return { ...built, sizeBytes: await readFileSize(options.out) }
}

async function buildZoningResult(
	kdb: DatabaseClient<ZoningDatabase>,
	options: BuildZoningOptions,
	tier: LayerTier,
	declaredFeatureCount: number,
	ingested: StreamResult
): Promise<Omit<BuildZoningResult, "sizeBytes">> {
	if (ingested.features !== declaredFeatureCount) {
		throw new Error(
			`zoning build: streamed ${ingested.features} features, the source declares ${declaredFeatureCount} — a short read builds a smaller country and reports success`
		)
	}

	if (options.expectedFeatureCount !== undefined && ingested.features !== options.expectedFeatureCount) {
		throw new Error(
			`zoning build: streamed ${ingested.features} features and the live service reports ${options.expectedFeatureCount} — the archive is a different vintage from the one the service is publishing`
		)
	}

	const area = assertAreaAgreement(ingested, options.expectedSourceAreaM2)

	// The crosswalk is not a table: the build checks it rather than assuming it.
	const nonFunctional = nonFunctionalPairs(ingested.crosswalkPairs)

	assertCrosswalkIsNotATable(ingested.crosswalkPairs, 0)

	options.onProgress?.(
		`${ingested.features.toLocaleString()} zoning polygons written · ${ingested.rings.total.toLocaleString()} rings ` +
			`(${ingested.rings.exteriors.toLocaleString()} exterior, ${ingested.rings.holes.toLocaleString()} hole)`
	)

	writeJurisdictionRows(kdb, ingested.jurisdictions)
	writePlanRows(kdb, ingested.plans)

	const vocabulary = writeVocabularyRows(kdb, ingested.vocabulary)

	const coverage = sourcePresentCoverageCells(ingested.observedByCoverageCell)

	assertNoNegativeClaim(coverage)

	await writeLayerCoverage(kdb, coverage)

	await writeLayerManifest(
		kdb,
		polygonLayerManifest(options, {
			name: GZT_LAYER_NAME,
			schemaVersion: ZONING_SCHEMA_VERSION,
			license: GZT_LICENSE,
			attribution: GZT_ATTRIBUTION,
			source: `arcgis.com item ${GZT_ITEM_ID}`,
			cellColumn: "zoning_cell.h3_cell",
			tier,
		})
	)

	const storedResolutions = (
		kdb.prepare("SELECT DISTINCT resolution FROM zoning_cell ORDER BY resolution").all() as Array<{
			resolution: number
		}>
	).map((row) => row.resolution)

	// Both probes this artifact serves already use primary keys, so it needs no secondary indexes.
	// An index over a `without rowid` table would roughly double the cell tier
	// to serve a scan that is already short.
	const totalCellRows = ingested.wholeCellRows + ingested.partialCellRows

	return {
		out: options.out.toString(),
		features: ingested.features,
		jurisdictions: ingested.jurisdictions.length,
		plans: ingested.plans.length,
		indexResolution: options.indexResolution,
		coverageResolution: options.coverageResolution,
		wholeCellRows: ingested.wholeCellRows,
		partialCellRows: ingested.partialCellRows,
		storedPartialShare: totalCellRows ? ingested.partialCellRows / totalCellRows : 0,
		coarsenedFeatures: ingested.coarsened,
		storedResolutions,
		coverageCells: coverage.length,
		coverageBasis: CoverageBasis.SourcePresent,
		tier,
		license: GZT_LICENSE,
		rings: ingested.rings,
		area,
		vocabulary,
		crosswalk: {
			pairs: ingested.crosswalkPairs.length,
			nonFunctionalPairs: nonFunctional.length,
			worst: nonFunctional
				.toSorted((left, right) => right[2].length - left[2].length)
				.slice(0, WORST_PAIRS_REPORTED)
				.map(([authorityCode, localCode, crosswalkCodes]) => ({ authorityCode, localCode, crosswalkCodes })),
		},
	}
}

interface StreamResult {
	features: number
	coarsened: number
	wholeCellRows: number
	partialCellRows: number
	observedByCoverageCell: Map<number, number>
	area: { signedM2: number; nestedM2: number; allExteriorM2: number }
	rings: {
		total: number
		exteriors: number
		holes: number
		nestedHoles: number
		adjacentHoles: number
		/**
		 * Features whose exterior was chosen by magnitude because no ring read as one
		 * by orientation, reported rather than implied to be zero.
		 */
		exteriorByMagnitude: number
	}
	jurisdictions: Array<[string, string]>
	plans: ZoningChunkResult["plans"]
	vocabulary: ObservedTerm[]
	crosswalkPairs: CrosswalkPair[]
}

/**
 * Add up what the chunks reported, exported for its own test.
 */
export function aggregateChunks(chunks: ReadonlyArray<ZoningChunkResult>): StreamResult {
	const observedByCoverageCell = new Map<number, number>()
	const jurisdictions = new Map<string, string>()
	const plans = new Map<string, ZoningChunkResult["plans"][number]>()
	const vocabulary = new Map<string, ObservedTerm>()
	const crosswalkPairs = new Map<string, Set<string>>()
	const pairNames = new Map<string, [string, string]>()

	let features = 0
	let coarsened = 0
	let wholeCellRows = 0
	let partialCellRows = 0
	let signedArea = 0
	let nestedArea = 0
	let allExteriorArea = 0
	let ringsTotal = 0
	let exteriors = 0
	let holes = 0
	let nestedHoles = 0
	let adjacentHoles = 0
	let exteriorByMagnitude = 0

	for (const chunk of chunks) {
		features += chunk.features
		coarsened += chunk.coarsened
		wholeCellRows += chunk.wholeCellRows
		partialCellRows += chunk.partialCellRows
		signedArea += chunk.area.signedM2
		nestedArea += chunk.area.nestedM2
		allExteriorArea += chunk.area.allExteriorM2
		ringsTotal += chunk.rings.total
		exteriors += chunk.rings.exteriors
		holes += chunk.rings.holes
		nestedHoles += chunk.rings.nestedHoles
		adjacentHoles += chunk.rings.adjacentHoles
		exteriorByMagnitude += chunk.rings.exteriorByMagnitude

		// A coverage cell straddles chunk boundaries, so counts add rather than replace.
		mergeCountsInto(observedByCoverageCell, chunk.observedByCoverageCell)

		for (const [code, name] of chunk.jurisdictions) {
			jurisdictions.set(code, name)
		}

		for (const plan of chunk.plans) {
			if (!plans.has(plan.planID)) {
				plans.set(plan.planID, plan)
			}
		}

		for (const [scheme, code, label, rows] of chunk.vocabulary) {
			const key = `${scheme}\u0000${code}`
			const existing = vocabulary.get(key)

			vocabulary.set(key, existing ? [scheme, code, existing[2], existing[3] + rows] : [scheme, code, label, rows])
		}

		// The pairs merge as a union, because a mapping that is not a function can look like one inside any single chunk.
		for (const [authorityCode, localCode, codes] of chunk.crosswalkPairs) {
			const key = `${authorityCode}\u0000${localCode}`
			const existing = crosswalkPairs.get(key)

			pairNames.set(key, [authorityCode, localCode])

			if (existing) {
				for (const code of codes) {
					existing.add(code)
				}
			} else {
				crosswalkPairs.set(key, new Set(codes))
			}
		}
	}

	return {
		features,
		coarsened,
		wholeCellRows,
		partialCellRows,
		observedByCoverageCell,
		area: { signedM2: signedArea, nestedM2: nestedArea, allExteriorM2: allExteriorArea },
		rings: { total: ringsTotal, exteriors, holes, nestedHoles, adjacentHoles, exteriorByMagnitude },
		jurisdictions: [...jurisdictions],
		plans: [...plans.values()],
		vocabulary: [...vocabulary.values()],
		crosswalkPairs: [...crosswalkPairs].map(([key, codes]) => {
			const [authorityCode, localCode] = pairNames.get(key)!

			return [authorityCode, localCode, [...codes].toSorted()] satisfies CrosswalkPair
		}),
	}
}

/**
 * The (authority, local code) pairs that take more than one generic type.
 */
export function nonFunctionalPairs(pairs: ReadonlyArray<CrosswalkPair>): CrosswalkPair[] {
	return pairs.filter((pair) => pair[2].length > 1)
}

/**
 * Refuse a crosswalk edge table while the publisher's mapping is not a function
 * of the (authority, code) pair.
 *
 * @throws {Error} When edges would be written while any pair is non-functional.
 */
export function assertCrosswalkIsNotATable(pairs: ReadonlyArray<CrosswalkPair>, edgeCount: number): void {
	if (!edgeCount) return

	const broken = nonFunctionalPairs(pairs)

	if (!broken.length) return

	const worst = broken.toSorted((left, right) => right[2].length - left[2].length)[0]!

	throw new Error(
		`zoning build: ${edgeCount} crosswalk edge(s) would be written while ${broken.length} of ${pairs.length} ` +
			`(authority, local code) pairs take more than one generic type — ${worst[0]} ${stringifyJSON(worst[1])} takes ` +
			`${worst[2].length} (${worst[2].join(", ")}). An edge table asserts that a code determines a type, and this ` +
			"publisher assigns the type per polygon, so the table would be this build's invention rather than the authority's mapping"
	)
}

function assertAreaAgreement(
	streamed: StreamResult,
	expectedSourceAreaM2: number | undefined
): BuildZoningResult["area"] {
	const signedKM2 = streamed.area.signedM2 / M2_PER_KM2

	// The publisher's figure is absent rather than defaulted.
	// This build's own reading would make the receipt print "0.000% apart" for a check that never ran.
	const reading = areaAgreementFrom(
		{ nestedM2: streamed.area.nestedM2, allExteriorM2: streamed.area.allExteriorM2 },
		expectedSourceAreaM2 ?? null
	)

	const area: BuildZoningResult["area"] = { ...reading, signedKM2 }

	if (reading.witness === "absent" || reading.relativeGap <= AREA_TOLERANCE) return area

	throw new Error(
		`zoning build: the encoded rings total ${reading.nestedKM2.toFixed(1)} km² against the publisher's ${reading.sourceKM2.toFixed(1)} km² ` +
			`(${(reading.relativeGap * 100).toFixed(2)}% apart, tolerance ${(AREA_TOLERANCE * 100).toFixed(0)}%). Read without their holes the same rings total ` +
			`${reading.allExteriorKM2.toFixed(1)} km², so compare the two: a hole-blind read answers "inside" for every point in a hole`
	)
}

/**
 * Run the ingest as a sequence of bounded child processes, over ranges of the authority's own feature ids.
 *
 * @throws {Error} When a chunk exits non-zero or prints no result line.
 * A chunk that died mid-range has written a partial set of rows.
 * The parent must stop before sealing that partial artifact.
 */
async function runBatchedIngest(
	tmpPath: string,
	options: BuildZoningOptions,
	batched: Extract<BuildZoningInput, { batched: unknown }>["batched"]
): Promise<StreamResult> {
	const chunkSize = batched.chunkSize ?? DEFAULT_CHUNK_SIZE
	const script = resolveModulePath("@mailwoman/zoning/sdk/ingest/worker")
	const chunks: ZoningChunkResult[] = []

	// The upper bound is deliberately open because the source reports a count instead of a maximum ID.
	// A range that stopped at the count would drop every feature after a numbering gap.
	let from = 1

	for (;;) {
		const to = from + chunkSize - 1

		options.onProgress?.(`chunk OBJECTID ${from}–${to}`)

		const result = await runChunkProcess<ZoningChunkResult>({
			script,
			context: "zoning build",
			args: ingestChunkArguments({
				database: tmpPath,
				args: ["--export", batched.exportPath, "--object-id-from", String(from), "--object-id-to", String(to)],
				indexResolution: options.indexResolution,
				coverageResolution: options.coverageResolution,
			}),
		})

		chunks.push(result)

		if (!result.features) break

		from = to + 1
	}

	return aggregateChunks(chunks)
}

/**
 * Refuse a coverage row that would license a negative claim.
 *
 * No row of this layer can support that claim because the Department publishes
 * coverage detail only in a map viewer.
 */
export function assertNoNegativeClaim(cells: ReadonlyArray<CoverageCell>): void {
	assertCoverageNoNegativeClaim("zoning build", cells, GZT_COVERAGE_LIMIT)
}

function writeJurisdictionRows(
	database: DatabaseClient<ZoningDatabase>,
	jurisdictions: ReadonlyArray<[string, string]>
): void {
	const insert = database.prepare(
		"INSERT INTO zoning_jurisdiction (jurisdiction_id, name, source_code, country) VALUES (?, ?, ?, ?)"
	)

	for (const [code, name] of jurisdictions.toSorted((left, right) => (left[0] < right[0] ? -1 : 1))) {
		// The id is the publisher's own code, preserved in both columns rather than repaired in one
		// because a repaired code is this package's spelling in a column that claims to be the publisher's.
		insert.run(code, name, code, "IE")
	}
}

function writePlanRows(database: DatabaseClient<ZoningDatabase>, plans: ZoningChunkResult["plans"]): void {
	const insert = database.prepare(
		"INSERT INTO zoning_plan (plan_id, jurisdiction_id, plan_name, plan_level, valid_from, valid_to, current_plan) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?)"
	)

	for (const plan of plans.toSorted((left, right) => (left.planID < right.planID ? -1 : 1))) {
		insert.run(plan.planID, plan.authorityCode, plan.name, plan.level, plan.from, plan.to, plan.currentPlan)
	}
}

/**
 * Insert the vocabulary, keeping every code the publisher declares at `observed_rows = 0`
 * and every used code it never declared at `declared = 0`.
 */
function writeVocabularyRows(
	database: DatabaseClient<ZoningDatabase>,
	observed: ReadonlyArray<ObservedTerm>
): BuildZoningResult["vocabulary"] {
	const insert = database.prepare(
		"INSERT INTO zoning_vocabulary (scheme, code, label, definition, definition_url, declared, observed_rows) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?)"
	)

	const rows = new Map<
		string,
		{ scheme: string; code: string; label: string; declared: number; observedRows: number }
	>()

	const declare = (scheme: string, code: string, label: string): void => {
		rows.set(`${scheme}\u0000${code}`, { scheme, code, label, declared: 1, observedRows: 0 })
	}

	for (const term of GZT_DECLARED_CODES) {
		declare(GZT_CROSSWALK_SCHEME, term.code, term.label)
	}

	for (const term of GZT_PLAN_LEVELS) {
		declare(PLAN_LEVEL_SCHEME, term.code, term.label)
	}

	for (const [scheme, code, label, observedRows] of observed) {
		const key = `${scheme}\u0000${code}`
		const existing = rows.get(key)

		if (existing) {
			existing.observedRows += observedRows

			continue
		}

		rows.set(key, {
			scheme,
			code,
			label,
			// `declared` is a property of the publisher's domain rather than of the scheme,
			// so a local authority's own codes are observed and an undeclared generic
			// type is what this column makes visible.
			declared: scheme === GZT_CROSSWALK_SCHEME && GZT_DECLARED_CODE_SET.has(code) ? 1 : 0,
			observedRows,
		})
	}

	const bySchema = new Map<string, { codes: number; undeclared: number; undeclaredCodes: string[] }>()

	for (const row of [...rows.values()].toSorted((left, right) =>
		left.scheme === right.scheme ? (left.code < right.code ? -1 : 1) : left.scheme < right.scheme ? -1 : 1
	)) {
		// NULL rather than a plausible URL, because the definitions behind the code-to-label pairs were not retrievable.
		insert.run(row.scheme, row.code, row.label, null, null, row.declared, row.observedRows)

		const census = bySchema.get(row.scheme) ?? { codes: 0, undeclared: 0, undeclaredCodes: [] }

		census.codes++

		// The census counts an undeclared code only where the publisher does publish a domain
		// to be outside of, since a local scheme is undeclared by construction.
		if (!row.declared && row.scheme === GZT_CROSSWALK_SCHEME) {
			census.undeclared++
			census.undeclaredCodes.push(row.code)
		}

		bySchema.set(row.scheme, census)
	}

	return [...bySchema].map(([scheme, census]) => ({ scheme, ...census }))
}
