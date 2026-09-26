/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The streaming pass — every feature into `coastal_zone_area` (or `coastal_ground_instability`) and into
 *   `coastal_zone_cell` — as a unit of work that can run over part of the source.
 *
 *   Bounded per range of the authority's own feature ids, because h3's wasm heap cannot be reset from
 *   JavaScript and does not survive an unbounded number of polyfill calls; a build that completes only when
 *   fragmentation happens to stay low is not reproducible.
 *
 *   The domain checks run here and throw: an unknown policy, policy interpretation or defence type is a
 *   source-schema change, and coercing it to a nearest neighbour or null converts "the source changed" into
 *   "there is no data here". The defence check compares case-folded and stores the source's own string for the
 *   source's inconsistent capitalization.
 *
 *   The chunk owns no artifact. It appends rows to a database the parent created and will seal, and returns
 *   counts the parent adds up; chunks run one at a time against that file, so there is no concurrent writer.
 */

import { stringifyJSON } from "@mailwoman/core/json"
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

import type { CoastalDatabase } from "#schema"
import type { CoastalFeatureSource, CoastalSourceFeature } from "#sdk/ingest/index"
import {
	foldDefenceType,
	NCERM_DEFENCE_TYPES_FOLDED,
	NCERM_POLICY_INTERPRETATION_VALUES,
	NCERM_POLICY_VALUES,
} from "#vocabulary"

/**
 * Rows per bulk-insert transaction.
 *
 * Chosen for the geometry table, whose rows carry a blob: a larger transaction
 * grows the write-ahead file without improving throughput.
 */
const INSERT_TRANSACTION_ROWS = 5000

const PROGRESS_STRIDE = 5000

/**
 * What one chunk produced.
 *
 * Every field is JSON-serializable, because a chunk normally reports across a process boundary.
 */
export interface CoastalChunkResult {
	erosionFeatures: number
	instabilityFeatures: number
	/**
	 * Features whose bounding box forced a resolution coarser than the target.
	 */
	coarsened: number
	/**
	 * Erosion features per scenario key — an object rather than a `Map` so it survives the process boundary.
	 */
	scenarioCounts: Record<string, number>
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
	 * Square metres: the source's own figure, the encoded rings read with their holes, and read without.
	 */
	area: { sourceM2: number; nestedM2: number; allExteriorM2: number }
	/**
	 * The defence types this chunk saw, with counts — a census carried on the receipt
	 * rather than only checked, because the authority publishes no list for the domain
	 * and the counts are how a reader sees it move.
	 */
	defenceTypeCounts: Array<[string, number]>
}

export interface IngestCoastalChunkOptions {
	source: CoastalFeatureSource
	indexResolution: number
	coverageResolution: number
	onProgress?: (message: string) => void
}

/**
 * Stream one chunk of the source into `database`.
 *
 * @throws {Error} On a value outside the authority's declared domains,
 * or on a feature the classifier refuses.
 */
export async function ingestCoastalChunk(
	database: DatabaseClient<CoastalDatabase>,
	options: IngestCoastalChunkOptions
): Promise<CoastalChunkResult> {
	const insertArea = database.prepare(
		"INSERT INTO coastal_zone_area (area_id, scenario_key, management, horizon, climate_allowance, frontage_id, " +
			"distance_m, smp_no, smp_name, smp_pu, mt_policy, mt_policy_interp, lt_policy, lt_policy_interp, defence_type, " +
			"published_year, max_overlap, min_lat, min_lon, max_lat, max_lon, rings) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)

	const insertCell = database.prepare(
		"INSERT INTO coastal_zone_cell (h3_cell, resolution, scenario_key, area_id, containment) VALUES (?, ?, ?, ?, ?)"
	)

	const insertInstability = database.prepare(
		"INSERT INTO coastal_ground_instability (area_id, kind, location, local_authority, smp_no, smp_name, " +
			"smp_policy_units, rear_scarp_probability, min_lat, min_lon, max_lat, max_lon, rings) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)

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

	const batch = beginBatched(database, { rowsPerCommit: INSERT_TRANSACTION_ROWS })

	try {
		for await (const feature of options.source.erosionFeatures()) {
			assertDeclaredDomains(feature)

			const bbox = ringsBoundingBox(feature.polygons)
			const areas = ringAreaReadings(feature.polygons)

			sourceArea += feature.sourceAreaM2
			nestedArea += areas.nested
			allExteriorArea += areas.allExterior

			insertArea.run(
				feature.areaID,
				feature.scenario.key,
				feature.scenario.management,
				feature.scenario.horizon,
				feature.scenario.climateAllowance,
				feature.frontageID,
				feature.distanceM,
				feature.smpNo,
				feature.smpName,
				feature.smpPolicyUnit,
				feature.mtPolicy,
				feature.mtPolicyInterpretation,
				feature.ltPolicy,
				feature.ltPolicyInterpretation,
				feature.defenceType,
				feature.publishedYear,
				feature.maxOverlap,
				bbox.minLat,
				bbox.minLon,
				bbox.maxLat,
				bbox.maxLon,
				encodeRings(feature.polygons)
			)

			const classified = classifyFeatureCells(
				feature.polygons,
				options.indexResolution,
				feature.areaID,
				"coastal cells"
			)

			if (classified.resolution !== options.indexResolution) {
				coarsened++
			}

			const coverageCells = new Set<number>()

			for (const row of featureCellRows(classified)) {
				insertCell.run(row.h3Cell, row.resolution, feature.scenario.key, feature.areaID, row.containment)

				if (row.containment === "whole") {
					wholeCellRows++
				} else {
					partialCellRows++
				}
			}

			// Coverage is derived from the uncompacted classification rather than the stored rows,
			// which is the reading a compaction decision cannot change.
			for (const cell of classified.whole) {
				addCoverageCells(coverageCells, cell, classified.resolution, options.coverageResolution)
			}

			for (const cell of classified.partial) {
				addCoverageCells(coverageCells, cell, classified.resolution, options.coverageResolution)
			}

			for (const coverageCell of coverageCells) {
				observedByCoverageCell.set(coverageCell, (observedByCoverageCell.get(coverageCell) ?? 0) + 1)
			}

			scenarioCounts[feature.scenario.key] = (scenarioCounts[feature.scenario.key] ?? 0) + 1

			if (feature.defenceType !== null) {
				defenceTypeCounts.set(feature.defenceType, (defenceTypeCounts.get(feature.defenceType) ?? 0) + 1)
			}

			erosionFeatures++

			batch.rowWritten()

			if (erosionFeatures % PROGRESS_STRIDE === 0) {
				options.onProgress?.(`${erosionFeatures.toLocaleString()} erosion features in this chunk`)
			}
		}

		for await (const feature of options.source.instabilityFeatures()) {
			const bbox = ringsBoundingBox(feature.polygons)
			const areas = ringAreaReadings(feature.polygons)

			sourceArea += feature.sourceAreaM2
			nestedArea += areas.nested
			allExteriorArea += areas.allExterior

			insertInstability.run(
				feature.areaID,
				feature.kind,
				feature.location,
				feature.localAuthority,
				feature.smpNo,
				feature.smpName,
				feature.smpPolicyUnits,
				feature.rearScarpProbability,
				bbox.minLat,
				bbox.minLon,
				bbox.maxLat,
				bbox.maxLon,
				encodeRings(feature.polygons)
			)

			// No cell rows: ground instability is a different hazard, and leaving it out of
			// the index is what makes it impossible for one to reach an erosion probe.
			instabilityFeatures++

			batch.rowWritten()
		}

		batch.commit()
	} catch (error) {
		batch.rollbackQuietly()

		throw error
	}

	return {
		erosionFeatures,
		instabilityFeatures,
		coarsened,
		scenarioCounts,
		wholeCellRows,
		partialCellRows,
		observedByCoverageCell: [...observedByCoverageCell],
		area: { sourceM2: sourceArea, nestedM2: nestedArea, allExteriorM2: allExteriorArea },
		defenceTypeCounts: [...defenceTypeCounts],
	}
}

/**
 * Refuse a feature carrying a value outside a domain the census enumerated
 * across all twelve published layers.
 */
function assertDeclaredDomains(feature: CoastalSourceFeature): void {
	for (const [field, value] of [
		["mt_smp", feature.mtPolicy],
		["lt_smp", feature.ltPolicy],
	] as Array<[string, string | null]>) {
		if (value !== null && !NCERM_POLICY_VALUES.has(value)) {
			throw new Error(
				`coastal build: ${feature.areaID} carries ${field} ${stringifyJSON(value)}, which is not in the authority's ` +
					`declared policy domain (${[...NCERM_POLICY_VALUES].map((entry) => stringifyJSON(entry)).join(", ")}) — ` +
					'an unknown value is a source-schema change, and coercing it would turn "the source changed" into "there is nothing here"'
			)
		}
	}

	for (const [field, value] of [
		["mt_smp_int", feature.mtPolicyInterpretation],
		["lt_smp_int", feature.ltPolicyInterpretation],
	] as Array<[string, string | null]>) {
		if (value !== null && !NCERM_POLICY_INTERPRETATION_VALUES.has(value)) {
			throw new Error(
				`coastal build: ${feature.areaID} carries ${field} ${stringifyJSON(value)}, which is not in the authority's ` +
					`declared interpretation domain (${[...NCERM_POLICY_INTERPRETATION_VALUES].map((entry) => stringifyJSON(entry)).join(", ")})`
			)
		}
	}

	if (feature.defenceType !== null && !NCERM_DEFENCE_TYPES_FOLDED.has(foldDefenceType(feature.defenceType))) {
		throw new Error(
			`coastal build: ${feature.areaID} carries def_type ${stringifyJSON(feature.defenceType)}, which is not in the ` +
				"authority's declared defence domain even case-folded — the fold exists for the source's own inconsistent " +
				"capitalization, not to absorb a new defence type"
		)
	}
}
