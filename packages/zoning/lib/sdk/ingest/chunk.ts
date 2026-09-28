/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The streaming pass, bounded to one process per range of the authority's own feature ids because h3's wasm heap cannot be reset from JavaScript and a build that completes only by luck is not reproducible.
 */

import {
	addCoverageCells,
	encodeRings,
	ringAreaReadings,
	ringsBoundingBox,
	classifyFeatureCells,
	featureCellRows,
} from "@mailwoman/spatial"
import { beginBatched } from "@mailwoman/sqlite/batched"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { ZoningDatabase } from "#schema"
import type { ZoningFeatureSource, ZoningSourceFeature } from "#sdk/ingest/index"
import { GZT_CROSSWALK_SCHEME, GZT_PROVENANCE_GRADE, GZT_ROLLUP_SCHEME, localSchemeFor } from "#vocabulary"

/**
 * Rows per bulk-insert transaction, chosen for the geometry table whose rows carry a blob
 * because a larger transaction grows the write-ahead file without improving throughput.
 */
const INSERT_TRANSACTION_ROWS = 5000

const PROGRESS_STRIDE = 5000

/**
 * One observed vocabulary value.
 *
 * It records the scheme and code.
 * It also records the publisher's label and row count.
 */
export type ObservedTerm = [scheme: string, code: string, label: string, rows: number]

/**
 * One (authority, local code) pair and every generic type the publisher assigned to it.
 */
export type CrosswalkPair = [authorityCode: string, localCode: string, crosswalkCodes: string[]]

/**
 * What one chunk produced, every field JSON-serializable because a chunk normally
 * reports across a process boundary.
 */
export interface ZoningChunkResult {
	features: number
	/**
	 * Features whose bounding box forced a resolution coarser than the target.
	 */
	coarsened: number
	/**
	 * Cell rows written, split by tier.
	 */
	wholeCellRows: number
	partialCellRows: number
	/**
	 * `[coverageCell, polygonsReachingIt]` pairs — an array rather than a `Map`
	 * so it survives the process boundary.
	 */
	observedByCoverageCell: Array<[number, number]>
	/**
	 * Square-metre area readings from the polygon rings.
	 *
	 * `signed` is the raw ring sum as published.
	 * `nested` accounts for holes in each polygon.
	 *
	 * `allExterior` reads the same rings as exterior boundaries without holes.
	 */
	area: { signedM2: number; nestedM2: number; allExteriorM2: number }
	/**
	 * The ring-role census — the receipt that the orientation was read rather than assumed.
	 */
	rings: {
		total: number
		exteriors: number
		holes: number
		nestedHoles: number
		adjacentHoles: number
		/**
		 * Features whose exterior was chosen by magnitude because no ring read as one by orientation.
		 */
		exteriorByMagnitude: number
	}
	/**
	 * The authorities this chunk saw, by their own code.
	 */
	jurisdictions: Array<[code: string, name: string]>

	plans: Array<{
		planID: string
		authorityCode: string
		name: string
		level: string
		from: string | null
		to: string | null
		currentPlan: number
	}>
	vocabulary: ObservedTerm[]
	crosswalkPairs: CrosswalkPair[]
}

export interface IngestZoningChunkOptions {
	source: ZoningFeatureSource
	indexResolution: number
	coverageResolution: number
	onProgress?: (message: string) => void
}

/**
 * Stream one chunk of the source into `database`.
 *
 * @throws {Error} On a feature the classifier or the ring-role resolver refuses.
 */
export async function ingestZoningChunk(
	database: DatabaseClient<ZoningDatabase>,
	options: IngestZoningChunkOptions
): Promise<ZoningChunkResult> {
	const insertArea = database.prepare(
		"INSERT INTO zoning_area (area_id, jurisdiction_id, plan_id, local_code, local_description, local_code_url, " +
			"crosswalk_code, crosswalk_scheme, crosswalk_description, crosswalk_rollup, provenance_grade, " +
			"min_lat, min_lon, max_lat, max_lon, ring_count, signed_area_m2, rings) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)

	const insertCell = database.prepare(
		"INSERT INTO zoning_cell (h3_cell, resolution, area_id, containment) VALUES (?, ?, ?, ?)"
	)

	const observedByCoverageCell = new Map<number, number>()
	const jurisdictions = new Map<string, string>()
	const plans = new Map<string, ZoningChunkResult["plans"][number]>()

	// Keyed on a NUL-joined pair and never split back apart, because a local code is
	// free text that routinely contains spaces and a key a reader had to re-split
	// would mangle the vocabulary this layer carries verbatim.
	const vocabulary = new Map<string, { scheme: string; code: string; label: string; rows: number }>()
	const crosswalkPairs = new Map<string, { authorityCode: string; localCode: string; codes: Set<string> }>()

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
	let exteriorByMagnitude = 0
	let adjacentHoles = 0

	/**
	 * Record one observed vocabulary value, keeping the first label so a later row's
	 * description leaves the publisher's vocabulary unchanged.
	 */
	const observe = (scheme: string, code: string, label: string): void => {
		const key = `${scheme}\u0000${code}`
		const existing = vocabulary.get(key)

		if (existing) {
			existing.rows++

			return
		}

		vocabulary.set(key, { scheme, code, label, rows: 1 })
	}

	const batch = beginBatched(database, { rowsPerCommit: INSERT_TRANSACTION_ROWS })

	try {
		for await (const feature of options.source.features()) {
			const bbox = ringsBoundingBox(feature.rings.polygons)
			const areas = ringAreaReadings(feature.rings.polygons)

			signedArea += feature.rings.signedAreaM2
			nestedArea += areas.nested
			allExteriorArea += areas.allExterior
			ringsTotal += feature.rings.ringCount
			exteriors += feature.rings.exteriorCount
			holes += feature.rings.holeCount
			nestedHoles += feature.rings.nestedHoles
			exteriorByMagnitude += feature.rings.exteriorByMagnitude
			adjacentHoles += feature.rings.adjacentHoles

			insertArea.run(
				feature.areaID,
				feature.authorityCode,
				feature.planID,
				feature.localCode,
				feature.localDescription,
				feature.localCodeURL,
				feature.crosswalkCode,
				feature.crosswalkCode === null ? null : GZT_CROSSWALK_SCHEME,
				feature.crosswalkDescription,
				feature.crosswalkRollup,
				// One grade per claim: every row of this artifact is `authoritative`,
				// and an observed land-use layer is a different database with a different
				// `layer_manifest.name` rather than a row with a second grade in this table.
				GZT_PROVENANCE_GRADE,
				bbox.minLat,
				bbox.minLon,
				bbox.maxLat,
				bbox.maxLon,
				feature.rings.ringCount,
				feature.rings.signedAreaM2,
				encodeRings(feature.rings.polygons)
			)

			const classified = classifyFeatureCells(
				feature.rings.polygons,
				options.indexResolution,
				feature.areaID,
				"zoning cells"
			)

			if (classified.resolution !== options.indexResolution) {
				coarsened++
			}

			for (const row of featureCellRows(classified)) {
				insertCell.run(row.h3Cell, row.resolution, feature.areaID, row.containment)

				if (row.containment === "whole") {
					wholeCellRows++
				} else {
					partialCellRows++
				}
			}

			// Coverage is derived from the uncompacted classification rather than the stored rows,
			// since the classification is the one compaction cannot change.
			const coverageCells = new Set<number>()

			for (const cell of classified.whole) {
				addCoverageCells(coverageCells, cell, classified.resolution, options.coverageResolution)
			}

			for (const cell of classified.partial) {
				addCoverageCells(coverageCells, cell, classified.resolution, options.coverageResolution)
			}

			for (const coverageCell of coverageCells) {
				observedByCoverageCell.set(coverageCell, (observedByCoverageCell.get(coverageCell) ?? 0) + 1)
			}

			jurisdictions.set(feature.authorityCode, feature.authorityName)

			if (!plans.has(feature.planID)) {
				plans.set(feature.planID, {
					planID: feature.planID,
					authorityCode: feature.authorityCode,
					name: feature.planName,
					level: feature.planLevel,
					from: feature.planFrom,
					to: feature.planTo,
					currentPlan: feature.currentPlan,
				})
			}

			// The local vocabulary is per authority, because codes collide across them.
			observe(localSchemeFor(feature.authorityCode), feature.localCode, feature.localDescription ?? feature.localCode)

			if (feature.crosswalkCode !== null) {
				observe(GZT_CROSSWALK_SCHEME, feature.crosswalkCode, feature.crosswalkDescription ?? feature.crosswalkCode)

				const key = `${feature.authorityCode}\u0000${feature.localCode}`
				const pair = crosswalkPairs.get(key)

				if (pair) {
					pair.codes.add(feature.crosswalkCode)
				} else {
					crosswalkPairs.set(key, {
						authorityCode: feature.authorityCode,
						localCode: feature.localCode,
						codes: new Set([feature.crosswalkCode]),
					})
				}
			}

			if (feature.crosswalkRollup !== null) {
				observe(GZT_ROLLUP_SCHEME, feature.crosswalkRollup, feature.crosswalkRollup)
			}

			features++

			batch.rowWritten()

			if (features % PROGRESS_STRIDE === 0) {
				options.onProgress?.(`${features.toLocaleString()} features in this chunk`)
			}
		}

		batch.commit()
	} catch (error) {
		batch.rollbackQuietly()

		throw error
	}

	return {
		features,
		coarsened,
		wholeCellRows,
		partialCellRows,
		observedByCoverageCell: [...observedByCoverageCell],
		area: { signedM2: signedArea, nestedM2: nestedArea, allExteriorM2: allExteriorArea },
		rings: { total: ringsTotal, exteriors, holes, nestedHoles, adjacentHoles, exteriorByMagnitude },
		jurisdictions: [...jurisdictions],
		plans: [...plans.values()],
		vocabulary: [...vocabulary.values()].map(
			(term) => [term.scheme, term.code, term.label, term.rows] satisfies ObservedTerm
		),
		crosswalkPairs: [...crosswalkPairs.values()].map(
			(pair) => [pair.authorityCode, pair.localCode, [...pair.codes].toSorted()] satisfies CrosswalkPair
		),
	}
}

/**
 * One feature's own contribution, for a caller that wants the numbers without a database —
 * the fixture rung's arithmetic and no more.
 */
export function featureAreaReadings(feature: ZoningSourceFeature): {
	signed: number
	nested: number
	allExterior: number
} {
	const areas = ringAreaReadings(feature.rings.polygons)

	return { signed: feature.rings.signedAreaM2, nested: areas.nested, allExterior: areas.allExterior }
}
