/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `zoning-ireland.db` — the sealed two-tier polygon layer, from the Department's bulk export.
 *
 *   THE COVERAGE IS `source_present` AND THE TIER IS `build-local`, AND THE TWO ARE INDEPENDENT REFUSALS.
 *   The coverage basis is about what the source can support: the Department publishes its coverage detail only
 *   inside a map viewer, so an absent zoning polygon is one of at least four different things and
 *   {@linkcode assertNoNegativeClaim} refuses anything stronger before a row is written. The tier is about
 *   what the LICENCE supports: three published statements disagree about the grant, so
 *   {@linkcode assertTierMatchesLicense} refuses a `shipped` build. Resolving either one does not resolve the
 *   other.
 *
 *   THE AREA CHECK IS THE HOLE CHECK, AND IT IS THE ONE THING HERE THAT IS EXACT. The service encodes hole
 *   roles by ring orientation, and reading them wrong is silent — a hole read as an exterior produces a
 *   well-formed polygon that answers "inside" for every location the plan carved out. Measured over the whole
 *   national export: the rings read WITH their holes total 5,444.5 km² and the Department's own `Shape__Area`
 *   sums to 5,444.5 km²; the same rings read WITHOUT their holes total 5,666.6 km². The publisher's figure has
 *   to come from the live service, because the bulk export drops the column — which is what makes this a
 *   two-path check rather than the archive agreeing with itself.
 *
 *   THERE IS NO BUILD-TIME TOUCH TABLE. A zoning cell row names ONE POLYGON, so it is final the moment that
 *   polygon is classified. The rows go straight in, and memory stays flat in row count with nothing to resolve
 *   afterwards.
 *
 *   THE INGEST IS BOUNDED ANYWAY. h3's WASM heap cannot be reset from JavaScript and does not survive an
 *   unbounded number of polyfill calls; a sibling product died twice on that, after roughly 510,000 and
 *   798,000 features. This product holds 85,330, so the whole country fits inside the 100,000-id default with
 *   room to spare — and the bound still ships, because a build that stays inside a ceiling by luck is not the
 *   same fact as one that cannot cross it.
 *
 *   THE JURISDICTION, PLAN AND VOCABULARY ROWS ARE WRITTEN BY THE PARENT, once, from the merged chunk
 *   reports. They are the only tables whose rows are partials across chunks — an authority and a plan appear
 *   in every chunk that touches them — and merging them in the parent is what keeps the chunk append-only.
 */

import {
	CoverageBasis,
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	supportsExclusion,
	writeLayerCoverage,
	writeLayerManifest,
	type CoverageCell,
} from "@mailwoman/core/layers"
import { runChunkProcess } from "@mailwoman/core/utils"
import { rmSync, statSync } from "@mailwoman/platform/fs"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { fileURLToPath } from "@mailwoman/platform/url"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"

import { createZoningTables, type ZoningDatabase } from "../schema.ts"
import {
	assertTierMatchesLicense,
	GZT_ATTRIBUTION,
	GZT_COVERAGE_LIMIT,
	GZT_CROSSWALK_SCHEME,
	GZT_DECLARED_CODES,
	GZT_DECLARED_CODE_SET,
	GZT_ITEM_ID,
	GZT_LAYER_NAME,
	GZT_LICENSE,
	GZT_PLAN_LEVELS,
} from "../vocabulary.ts"
import type { CrosswalkPair, ObservedTerm, ZoningChunkResult } from "./ingest-chunk.ts"
import { ingestZoningChunk } from "./ingest-chunk.ts"
import type { ZoningFeatureSource } from "./ingest.ts"

/**
 * Schema version of the domain tables. Bumped when a column changes meaning, never for an added column a reader can
 * ignore.
 */
export const ZONING_SCHEMA_VERSION = 1

/**
 * The plan-level vocabulary scheme.
 */
export const PLAN_LEVEL_SCHEME = "IE-PLAN-LEVEL"

/**
 * Feature ids per chunk process.
 *
 * Sized against the measured ceiling on a sibling product rather than guessed: single-process runs over that layer died
 * after roughly 510,000 and 798,000 features as h3's WASM heap fragmented. This product holds 85,330 features, so this
 * default puts the whole country in one process — and it is the ceiling that makes the build reproducible rather than
 * the fact that this product happens to sit below it.
 *
 * A SMALLER CHUNK COSTS A FULL PASS EACH. The source is one 247 MB GeoJSON document rather than an indexed store, so
 * ogr2ogr scans all of it per range: measured at 13.2 s per pass on this lab.
 */
export const DEFAULT_CHUNK_SIZE = 100_000

/**
 * Where a build gets its features, and — for a real one — how it bounds each process's share of them.
 */
export type BuildZoningInput =
	| {
			/**
			 * A feature source consumed IN THIS PROCESS. Correct for a fixture and for anything small; it is what the batched
			 * form falls back to per chunk, so the two share one implementation.
			 */
			source: ZoningFeatureSource
	  }
	| {
			/**
			 * The bulk export, ingested in bounded chunks — one child process per range of the authority's own feature ids.
			 */
			batched: {
				exportPath: string
				/**
				 * Feature ids per chunk. See {@link DEFAULT_CHUNK_SIZE}.
				 */
				chunkSize?: number
				/**
				 * The feature count the whole build should yield.
				 */
				declaredFeatureCount: number
			}
	  }

export type BuildZoningOptions = BuildZoningInput & {
	/**
	 * Where the sealed artifact lands. The build writes beside it and swaps.
	 */
	out: string
	/**
	 * The product vintage — `layer_manifest.version` and `source_vintage`.
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
	 * The resolution the cell index is built at — chosen from the candidates-per-cell and zero-cell measurement.
	 */
	indexResolution: number
	/**
	 * The resolution `layer_coverage` rows are keyed at. Must be coarser than the index resolution.
	 */
	coverageResolution: number
	/**
	 * The publisher's OWN area figure for the whole product, in square metres — its `Shape__Area` sum, read from the live
	 * service. Supplied, the build asserts the rings it encoded agree with it.
	 */
	expectedSourceAreaM2?: number
	/**
	 * The feature count the live service reports. Supplied, the build asserts its own streamed total against it.
	 */
	expectedFeatureCount?: number
	/**
	 * The tier to stamp. `build-local` unless the licence contradiction is resolved — see
	 * {@link assertTierMatchesLicense}.
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
	 * The basis every coverage row carries. `source_present`, always, while `zoning_mapped_extent` is empty.
	 */
	coverageBasis: CoverageBasis
	tier: LayerTier
	license: string
	/**
	 * The ring-role census: how many rings, how many the orientation read as exteriors and holes, and how many holes were
	 * placed on their parent's boundary rather than inside it.
	 */
	rings: {
		total: number
		exteriors: number
		holes: number
		nestedHoles: number
		adjacentHoles: number
		/**
		 * Features whose exterior was chosen by MAGNITUDE because no ring read as one by orientation. Measured at ONE of
		 * 85,330 — a three-vertex sliver enclosing 3.0 × 10⁻⁷ m², where a ring's winding is floating-point noise rather
		 * than something the publisher stated. Reported rather than implied to be zero.
		 */
		exteriorByMagnitude: number
	}
	/**
	 * The three area totals, in square kilometres: what the publisher says, what the encoded rings say read with their
	 * holes, and what they would say read without.
	 */
	area: {
		/**
		 * The publisher's own figure, in square kilometres — ABSENT where it was not read. Never defaulted to this build's
		 * own reading: a receipt printing "publisher 205.4 km², 0.000% apart" when nobody asked the publisher is a check
		 * reporting itself as passed.
		 */
		sourceKM2?: number
		nestedKM2: number
		allExteriorKM2: number
		signedKM2: number
		/**
		 * `|nested − source| / source`. ABSENT where the publisher's figure was not read.
		 */
		relativeGap?: number
	}
	/**
	 * The vocabulary census, per scheme: how many codes the artifact holds and how many of them the publisher never
	 * declared.
	 */
	vocabulary: Array<{ scheme: string; codes: number; undeclared: number; undeclaredCodes: string[] }>
	/**
	 * (authority, local code) pairs, and how many of them take MORE THAN ONE generic type — the measurement that keeps
	 * `zoning_crosswalk_edge` empty.
	 */
	crosswalk: {
		pairs: number
		nonFunctionalPairs: number
		/**
		 * The worst offenders, most generic types first, for the receipt.
		 */
		worst: Array<{ authorityCode: string; localCode: string; crosswalkCodes: string[] }>
	}
	sizeBytes: number
}

/**
 * Square metres in a square kilometre.
 */
const M2_PER_KM2 = 1_000_000

/**
 * The relative gap between the two area readings that fails the build.
 *
 * The comparison is a SPHERICAL ring area against the publisher's PLANAR figure in Irish Transverse Mercator, so the
 * two never agree exactly: ITM's scale factor runs 0.99982 at its central meridian and above 1 towards the edges of the
 * island, which contributes a few tenths of a percent to an area, and the spherical approximation contributes a similar
 * amount against the ellipsoid. Measured on the largest feature in the country: 2,223.1 km² spherical against the
 * Department's 2,232.1 km², 0.40% apart. One percent leaves that comfortably inside the tolerance while sitting well
 * below the 4.1% a hole-blind read produces over the same set.
 */
const AREA_TOLERANCE = 0.01

/**
 * How many non-functional crosswalk pairs the receipt names.
 */
const WORST_PAIRS_REPORTED = 8

/**
 * Build the layer.
 *
 * @throws {Error} On a feature that reaches no cell, a feature count that disagrees with the source's own declaration,
 *   an area total that disagrees with the publisher's, a coverage row that would license a negative claim, a crosswalk
 *   edge table written while the mapping is not a function, or a `shipped` tier asked for under an unresolved licence.
 */
export async function buildZoningDatabase(options: BuildZoningOptions): Promise<BuildZoningResult> {
	const tier = options.tier ?? LayerTier.BuildLocal

	assertTierMatchesLicense(tier, GZT_LICENSE)

	if (options.coverageResolution >= options.indexResolution) {
		throw new Error(
			`zoning build: the coverage resolution (${options.coverageResolution}) must be coarser than the index resolution (${options.indexResolution}) — a row's coverage cell is the PARENT of its index cell`
		)
	}

	const declaredFeatureCount =
		"batched" in options ? options.batched.declaredFeatureCount : options.source.declaredFeatureCount

	options.onProgress?.(
		"batched" in options
			? `source: ${options.batched.exportPath} · ${declaredFeatureCount.toLocaleString()} features`
			: `source: EPSG:${options.source.epsg} · ${declaredFeatureCount.toLocaleString()} features · ${options.source.origin}`
	)

	const tmpPath = `${options.out}.tmp-${process.pid}`

	// THE INGEST AND THE WRITE-OUT PHASES USE SEPARATE HANDLES, ALWAYS — including the in-process path, which does not
	// need them separated. The batched path DOES: its children open the same file, so the parent's handle has to be closed
	// across them, and a single shared handle silently becomes a closed one afterwards. Doing it one way in both paths is
	// what puts the fixture suites on the same sequence a national build takes.
	let streamed: StreamResult

	{
		const database = new DatabaseSync(tmpPath)
		const kdb = new DatabaseClient<ZoningDatabase>(database)

		try {
			database.exec("PRAGMA journal_mode = OFF")
			database.exec("PRAGMA synchronous = OFF")

			await createZoningTables(kdb)
			await createLayerManifestTable(kdb)
			await createLayerCoverageTable(kdb)

			if (!("batched" in options)) {
				streamed = aggregateChunks([
					await ingestZoningChunk(database, {
						source: options.source,
						indexResolution: options.indexResolution,
						coverageResolution: options.coverageResolution,
						...(options.onProgress ? { onProgress: options.onProgress } : {}),
					}),
				])
			}
		} catch (error) {
			await kdb.destroy().catch(() => undefined)
			rmSync(tmpPath, { force: true })

			throw error
		}

		await kdb.destroy()
	}

	if ("batched" in options) {
		try {
			streamed = await runBatchedIngest(tmpPath, options)
		} catch (error) {
			rmSync(tmpPath, { force: true })

			throw error
		}
	}

	const database = new DatabaseSync(tmpPath)
	const kdb = new DatabaseClient<ZoningDatabase>(database)

	try {
		database.exec("PRAGMA journal_mode = OFF")
		database.exec("PRAGMA synchronous = OFF")

		const ingested = streamed!

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

		// THE CROSSWALK IS NOT A TABLE, AND THE BUILD CHECKS IT RATHER THAN ASSUMING IT. Writing no edges while the mapping
		// happens not to be a function would be an accident; refusing to write them while it is not is a statement.
		const nonFunctional = nonFunctionalPairs(ingested.crosswalkPairs)

		assertCrosswalkIsNotATable(ingested.crosswalkPairs, 0)

		options.onProgress?.(
			`${ingested.features.toLocaleString()} zoning polygons written · ${ingested.rings.total.toLocaleString()} rings ` +
				`(${ingested.rings.exteriors.toLocaleString()} exterior, ${ingested.rings.holes.toLocaleString()} hole)`
		)

		writeJurisdictionRows(database, ingested.jurisdictions)
		writePlanRows(database, ingested.plans)

		const vocabulary = writeVocabularyRows(database, ingested.vocabulary)

		const coverage = buildCoverageCells(ingested.observedByCoverageCell)

		assertNoNegativeClaim(coverage)

		await writeLayerCoverage(kdb, coverage)

		await writeLayerManifest(kdb, {
			name: GZT_LAYER_NAME,
			version: options.sourceVintage,
			schemaVersion: ZONING_SCHEMA_VERSION,
			tier,
			license: GZT_LICENSE,
			attribution: GZT_ATTRIBUTION,
			source: `arcgis.com item ${GZT_ITEM_ID}`,
			sourceVintage: options.sourceVintage,
			buildCmd: options.buildCmd,
			buildSHA: options.buildSHA,
			freshnessPolicy: LayerFreshnessPolicy.VersionedRefresh,
			spineKeys: {
				h3: { column: "zoning_cell.h3_cell", resolution: options.indexResolution },
			},
			createdAt: options.createdAt,
		})

		const storedResolutions = (
			database.prepare("SELECT DISTINCT resolution FROM zoning_cell ORDER BY resolution").all() as Array<{
				resolution: number
			}>
		).map((row) => row.resolution)

		// NO SECONDARY INDEXES, AND THAT IS A DECISION RATHER THAN AN OMISSION. Both probes this artifact serves are already
		// primary-key probes: the cell table's `(h3_cell, area_id)` key answers `WHERE h3_cell = ?` as a range scan of a
		// handful of rows, and the geometry table is probed by `area_id`, its own key. An index over a `WITHOUT ROWID` table
		// carries the primary key in every entry, so it would roughly double the cell tier to serve a scan that is already
		// short.
		database.exec("VACUUM")

		await kdb.destroy()

		sealDatabase(tmpPath)
		swapDatabaseIntoPlace(tmpPath, options.out)

		const totalCellRows = ingested.wholeCellRows + ingested.partialCellRows

		return {
			out: options.out,
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
			sizeBytes: sizeOf(options.out),
		}
	} catch (error) {
		await kdb.destroy().catch(() => undefined)

		// A failed build leaves a partial file whose name carries this process's pid, so nothing will ever pick it up again.
		// Removing it is the difference between a retry loop that fails and one that fills a disk.
		rmSync(tmpPath, { force: true })

		throw error
	}
}

/**
 * What the whole ingest produced, however many processes it took.
 */
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
		 * Features whose exterior was chosen by MAGNITUDE because no ring read as one by orientation. Measured at ONE of
		 * 85,330 — a three-vertex sliver enclosing 3.0 × 10⁻⁷ m², where a ring's winding is floating-point noise rather
		 * than something the publisher stated. Reported rather than implied to be zero.
		 */
		exteriorByMagnitude: number
	}
	jurisdictions: Array<[string, string]>
	plans: ZoningChunkResult["plans"]
	vocabulary: ObservedTerm[]
	crosswalkPairs: CrosswalkPair[]
}

/**
 * Add up what the chunks reported.
 *
 * Exported for its own test: the coverage-cell arithmetic and the crosswalk-pair merge are the parts of the batched
 * path a fixture build cannot reach, and getting either wrong produces a well-formed artifact — one that under-reports
 * how many polygons a cell holds, or one that reports a mapping as a function because no single chunk saw it break.
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

		// A coverage cell straddles chunk boundaries, so the counts ADD rather than replace. Taking the last chunk's value
		// would report a cell as holding only the last chunk's polygons.
		for (const [cell, count] of chunk.observedByCoverageCell) {
			observedByCoverageCell.set(cell, (observedByCoverageCell.get(cell) ?? 0) + count)
		}

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

		// THE PAIRS MERGE AS A UNION, and that is the whole point of doing it here. A mapping that is not a function can look
		// like one inside any single chunk: Cork's `Special Policy Area` takes 14 generic types across the county, and a
		// chunk holding a prefix of its feature ids may well have seen only one of them.
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
 * Refuse a crosswalk EDGE TABLE while the publisher's mapping is not a function of the (authority, code) pair.
 *
 * An edge table asserts that a code determines a type. Measured nationally, 52 of 795 pairs take more than one — Cork
 * County Council's `Special Policy Area` takes 14 — so an edge table built from this data would have to pick one type
 * per pair and would be this package's invention rather than the Department's mapping. The mapping lives per polygon,
 * on `zoning_area`, where the Department put it.
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
			`(authority, local code) pairs take more than one generic type — ${worst[0]} ${JSON.stringify(worst[1])} takes ` +
			`${worst[2].length} (${worst[2].join(", ")}). An edge table asserts that a code determines a type, and this ` +
			"publisher assigns the type per polygon, so the table would be this build's invention rather than the authority's mapping"
	)
}

/**
 * Refuse an artifact whose rings do not add up to the area the publisher itself reports.
 *
 * The message carries the hole-blind total beside the nested one, because the gap between them is the diagnosis: a hole
 * read as an exterior ring answers "inside" for every point in it.
 */
function assertAreaAgreement(
	streamed: StreamResult,
	expectedSourceAreaM2: number | undefined
): BuildZoningResult["area"] {
	const nestedKM2 = streamed.area.nestedM2 / M2_PER_KM2
	const allExteriorKM2 = streamed.area.allExteriorM2 / M2_PER_KM2
	const signedKM2 = streamed.area.signedM2 / M2_PER_KM2

	// THE PUBLISHER'S FIGURE IS ABSENT RATHER THAN DEFAULTED. Filling it with this build's own reading would make the
	// receipt print "0.000% apart" for a check that never ran, which is the one shape a reader cannot tell from a pass.
	if (expectedSourceAreaM2 === undefined) return { nestedKM2, allExteriorKM2, signedKM2 }

	const relativeGap = expectedSourceAreaM2
		? Math.abs(streamed.area.nestedM2 - expectedSourceAreaM2) / expectedSourceAreaM2
		: 0

	const area: BuildZoningResult["area"] = {
		sourceKM2: expectedSourceAreaM2 / M2_PER_KM2,
		nestedKM2,
		allExteriorKM2,
		signedKM2,
		relativeGap,
	}

	if (relativeGap <= AREA_TOLERANCE) return area

	throw new Error(
		`zoning build: the encoded rings total ${nestedKM2.toFixed(1)} km² against the publisher's ${(expectedSourceAreaM2 / M2_PER_KM2).toFixed(1)} km² ` +
			`(${(relativeGap * 100).toFixed(2)}% apart, tolerance ${(AREA_TOLERANCE * 100).toFixed(0)}%). Read without their holes the same rings total ` +
			`${allExteriorKM2.toFixed(1)} km², so compare the two: a hole-blind read answers "inside" for every point in a hole`
	)
}

/**
 * Run the ingest as a sequence of bounded child processes, over ranges of the authority's own feature ids.
 *
 * THE PARENT HOLDS NO HANDLE WHILE THEY RUN — its caller closed one before this and opens another after. Each child
 * opens the same file and appends; chunks run one at a time, so there is exactly one writer at every instant and no
 * locking to reason about.
 *
 * @throws {Error} When a chunk exits non-zero, or prints no result line — a chunk that died mid-range has written a
 *   partial set of rows, and continuing would seal an artifact missing features nobody could name.
 */
async function runBatchedIngest(
	tmpPath: string,
	options: BuildZoningOptions & { batched: Extract<BuildZoningInput, { batched: unknown }>["batched"] }
): Promise<StreamResult> {
	const { batched } = options
	const chunkSize = batched.chunkSize ?? DEFAULT_CHUNK_SIZE
	const script = fileURLToPath(import.meta.resolve("@mailwoman/zoning/scripts/ingest-chunk"))
	const chunks: ZoningChunkResult[] = []

	// The upper bound is deliberately open — the source reports a count, not a maximum id, and a range that stopped at the
	// count would drop every feature past a gap in the numbering.
	let from = 1

	for (;;) {
		const to = from + chunkSize - 1

		options.onProgress?.(`chunk OBJECTID ${from}–${to}`)

		const result = await runChunk(script, [
			"--database",
			tmpPath,
			"--export",
			batched.exportPath,
			"--object-id-from",
			String(from),
			"--object-id-to",
			String(to),
			"--index-resolution",
			String(options.indexResolution),
			"--coverage-resolution",
			String(options.coverageResolution),
		])

		chunks.push(result)

		if (!result.features) break

		from = to + 1
	}

	return aggregateChunks(chunks)
}

/**
 * Run one chunk process and parse its result line.
 *
 * Progress is INHERITED rather than captured, so a long chunk reports as it goes and only the result line has to be
 * parsed. A non-zero exit throws: a chunk that died mid-range has already written part of its rows, and continuing
 * would seal an artifact missing features nobody could name.
 */
async function runChunk(script: string, args: readonly string[]): Promise<ZoningChunkResult> {
	return runChunkProcess<ZoningChunkResult>({ script, args, context: "zoning build" })
}

/**
 * The coverage rows: one per cell the authority's own polygons reach, and none anywhere else.
 *
 * `observed_rows` counts the polygons reaching the cell, which is what the contract's column means. There is no
 * zero-row cell here and there cannot be one: a cell with no polygon gets NO ROW, because this product publishes
 * nothing that would let an empty cell be distinguished from land outside any adopted plan.
 */
function buildCoverageCells(observed: Map<number, number>): CoverageCell[] {
	const cells: CoverageCell[] = []

	for (const [h3Cell, observedRows] of observed) {
		cells.push({ h3Cell, completeness: 1, basis: CoverageBasis.SourcePresent, observedRows })
	}

	return cells.toSorted((left, right) => left.h3Cell - right.h3Cell)
}

/**
 * Refuse a coverage row that would license a negative claim.
 *
 * THIS IS THE CHECK THE MEANING-OF-ZERO RULE TURNS ON, and it is a condition rather than a convention. The Department
 * publishes its coverage detail only inside a map viewer, so no row of this layer may support an exclusion — a
 * `designated` or `surveyed` basis here would let an absent zoning polygon be read as a statement that no restriction
 * applies, over most of the map. The reader checks the same thing at open time, so an artifact built by some other path
 * cannot get past it either.
 */
export function assertNoNegativeClaim(cells: ReadonlyArray<CoverageCell>): void {
	for (const cell of cells) {
		if (supportsExclusion(cell)) {
			throw new Error(
				`zoning build: coverage cell ${cell.h3Cell} carries basis ${JSON.stringify(cell.basis)}, which supports an EXCLUSION. ` +
					`${GZT_COVERAGE_LIMIT} Until a mapped-footprint source is settled, every row must read ${CoverageBasis.SourcePresent}`
			)
		}
	}
}

/**
 * Insert the authorities.
 */
function writeJurisdictionRows(database: DatabaseSync, jurisdictions: ReadonlyArray<[string, string]>): void {
	const insert = database.prepare(
		"INSERT INTO zoning_jurisdiction (jurisdiction_id, name, source_code, country) VALUES (?, ?, ?, ?)"
	)

	for (const [code, name] of jurisdictions.toSorted((left, right) => (left[0] < right[0] ? -1 : 1))) {
		// The id IS the publisher's own code. `Fl` for Fingal against `CL`, `CO`, `DU` for the rest — carried in both
		// columns rather than repaired in one, because a repaired code is this package's spelling in a column that claims to
		// be the publisher's.
		insert.run(code, name, code, "IE")
	}
}

/**
 * Insert the plans.
 */
function writePlanRows(database: DatabaseSync, plans: ZoningChunkResult["plans"]): void {
	const insert = database.prepare(
		"INSERT INTO zoning_plan (plan_id, jurisdiction_id, plan_name, plan_level, valid_from, valid_to, current_plan) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?)"
	)

	for (const plan of plans.toSorted((left, right) => (left.planID < right.planID ? -1 : 1))) {
		insert.run(plan.planID, plan.authorityCode, plan.name, plan.level, plan.from, plan.to, plan.currentPlan)
	}
}

/**
 * Insert the vocabulary: every code the publisher DECLARES, plus every code the DATA uses, with the difference recorded
 * rather than folded away.
 *
 * A declared code the data never uses is kept at `observed_rows = 0`, because the domain is the publisher's statement
 * of what a value may be rather than a census of what it is — Ireland's `SDZ` plan level is exactly that. A used code
 * the publisher never declared is kept at `declared = 0`, because inventing a declaration would make a source-schema
 * change indistinguishable from the publisher's own vocabulary.
 */
function writeVocabularyRows(
	database: DatabaseSync,
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
			// DECLARED IS A PROPERTY OF THE PUBLISHER'S DOMAIN, NOT OF THE SCHEME. A local authority's own codes are observed
			// rather than declared — the Department publishes no domain for them — and an undeclared generic type is the event
			// this column exists to make visible.
			declared: scheme === GZT_CROSSWALK_SCHEME && GZT_DECLARED_CODE_SET.has(code) ? 1 : 0,
			observedRows,
		})
	}

	const bySchema = new Map<string, { codes: number; undeclared: number; undeclaredCodes: string[] }>()

	for (const row of [...rows.values()].toSorted((left, right) =>
		left.scheme === right.scheme ? (left.code < right.code ? -1 : 1) : left.scheme < right.scheme ? -1 : 1
	)) {
		// NULL, not a plausible URL. Every one of the 85,330 rows links its generic type's definition to `viewer.myplan.ie`,
		// which has no DNS record, and three candidate replacements on the live host answer HTTP 404 — so the definitions
		// behind the code-to-label pairs were not retrievable and this column says so by being empty.
		insert.run(row.scheme, row.code, row.label, null, null, row.declared, row.observedRows)

		const census = bySchema.get(row.scheme) ?? { codes: 0, undeclared: 0, undeclaredCodes: [] }

		census.codes++

		// A LOCAL SCHEME IS UNDECLARED BY CONSTRUCTION and reporting it as such would bury the one that matters. The census
		// counts an undeclared code only where the publisher DOES publish a domain to be outside of.
		if (!row.declared && row.scheme === GZT_CROSSWALK_SCHEME) {
			census.undeclared++
			census.undeclaredCodes.push(row.code)
		}

		bySchema.set(row.scheme, census)
	}

	return [...bySchema].map(([scheme, census]) => ({ scheme, ...census }))
}

/**
 * The artifact's size on disk, read once for the receipt.
 */
function sizeOf(path: string): number {
	return statSync(path).size
}
