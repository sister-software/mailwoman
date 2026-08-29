/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The streaming pass — every feature into `coastal_zone_area` (or `coastal_ground_instability`) and into
 *   `coastal_zone_cell` — as a unit of work that can run over PART of the source.
 *
 *   WHY THIS IS A CHUNK RATHER THAN THE WHOLE FILE. h3's WASM heap cannot be reset from JavaScript, and it
 *   does not survive an unbounded number of polyfill calls: over the sibling flood product, runs died after
 *   roughly 510,000 and 798,000 features on geometry that classifies in milliseconds in a fresh process. A
 *   build that completes only when fragmentation happens to stay low is not a reproducible build, so the
 *   classification is bounded BY CONSTRUCTION — one process per range of the authority's own feature ids.
 *   This product is small enough that one chunk per layer fits inside the default bound; the bound ships
 *   anyway, because determinism by construction is not the same fact as determinism by luck.
 *
 *   THE DOMAIN CHECKS RUN HERE, AND THEY THROW. An unknown policy, policy interpretation or defence type is a
 *   source-schema change, which is the event a reader most needs to hear about; coercing it to a nearest
 *   neighbour or to null converts "the source changed" into "there is nothing here". The defence check
 *   compares case-folded and stores the source's own string, because the census found `Sheet piles` beside
 *   `Sheet Piles` and `Vertical Wall - Concrete` beside `Vertical Wall - concrete`.
 *
 *   THE CHUNK OWNS NO ARTIFACT. It appends rows to a database the parent created and will seal, and returns
 *   counts the parent adds up. Chunks run one at a time against that file, so there is no concurrent writer
 *   and no locking to reason about.
 */

import { addCoverageCells, encodeRings, ringAreaReadings, ringsBoundingBox } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { CoastalDatabase } from "../schema.ts"
import {
	foldDefenceType,
	NCERM_DEFENCE_TYPES_FOLDED,
	NCERM_POLICY_INTERPRETATION_VALUES,
	NCERM_POLICY_VALUES,
} from "../vocabulary.ts"
import { classifyFeatureCells, featureCellRows } from "./cells.ts"
import type { CoastalFeatureSource, CoastalSourceFeature } from "./ingest.ts"

/**
 * Rows per bulk-insert transaction. Chosen for the geometry table, whose rows carry a blob: a larger transaction grows
 * the write-ahead file without improving throughput.
 */
const INSERT_TRANSACTION_ROWS = 5000

/**
 * Features between progress reports.
 */
const PROGRESS_STRIDE = 5000

/**
 * What one chunk produced. Every field is JSON-serializable, because a chunk normally reports across a process
 * boundary.
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
	 * `[coverageCell, polygonsReachingIt]` pairs — an array rather than a `Map` so it survives the process boundary.
	 */
	observedByCoverageCell: Array<[number, number]>
	/**
	 * Square metres: the source's own figure, the encoded rings read WITH their holes, and read without.
	 */
	area: { sourceM2: number; nestedM2: number; allExteriorM2: number }
	/**
	 * The defence types this chunk saw, with counts — a census carried on the receipt rather than only checked, because
	 * the domain is one the authority publishes no list for and the counts are how a reader sees it move.
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
 * @throws {Error} On a value outside the authority's declared domains, or on a feature the classifier refuses.
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
	let pending = 0
	let coarsened = 0
	let wholeCellRows = 0
	let partialCellRows = 0
	let sourceArea = 0
	let nestedArea = 0
	let allExteriorArea = 0

	database.exec("BEGIN")

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

			// COVERAGE IS DERIVED FROM THE UNCOMPACTED CLASSIFICATION, not from the stored rows. A compacted parent spans
			// several coverage cells and `addCoverageCells` handles that, but the fringe is where this product's cells almost
			// all are — so counting off the stored rows and counting off the classification agree here, and the
			// classification is the one that cannot be changed by a compaction decision.
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

			pending++

			if (pending >= INSERT_TRANSACTION_ROWS) {
				database.exec("COMMIT")
				database.exec("BEGIN")

				pending = 0
			}

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

			// NO CELL ROWS, AND THE ABSENCE IS THE STRUCTURE. Ground instability is a different hazard from coastal erosion,
			// and 160 rows answer a bounding-box scan faster than an index would. Not indexing them is what makes it
			// impossible for one to reach an erosion probe.
			instabilityFeatures++

			pending++

			if (pending >= INSERT_TRANSACTION_ROWS) {
				database.exec("COMMIT")
				database.exec("BEGIN")

				pending = 0
			}
		}

		database.exec("COMMIT")
	} catch (error) {
		// Best-effort, and it must never replace the real error: the build runs with the journal off (nothing here is ever
		// published without the swap), so SQLite may refuse to unwind. What matters is that the caller sees WHY the ingest
		// stopped, not that a scratch file was tidied.
		try {
			database.exec("ROLLBACK")
		} catch {
			// The temp artifact is discarded either way.
		}

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
 * Refuse a feature carrying a value outside a domain the census enumerated.
 *
 * Every domain here was read across all twelve published layers rather than one, because a domain taken from a single
 * layer throws on the day another layer carries its ninth value — and the two policy fields already disagree with each
 * other on the spelling of one policy, which a single-field census would have missed.
 */
function assertDeclaredDomains(feature: CoastalSourceFeature): void {
	for (const [field, value] of [
		["mt_smp", feature.mtPolicy],
		["lt_smp", feature.ltPolicy],
	] as Array<[string, string | null]>) {
		if (value !== null && !NCERM_POLICY_VALUES.has(value)) {
			throw new Error(
				`coastal build: ${feature.areaID} carries ${field} ${JSON.stringify(value)}, which is not in the authority's ` +
					`declared policy domain (${[...NCERM_POLICY_VALUES].map((entry) => JSON.stringify(entry)).join(", ")}) — ` +
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
				`coastal build: ${feature.areaID} carries ${field} ${JSON.stringify(value)}, which is not in the authority's ` +
					`declared interpretation domain (${[...NCERM_POLICY_INTERPRETATION_VALUES].map((entry) => JSON.stringify(entry)).join(", ")})`
			)
		}
	}

	if (feature.defenceType !== null && !NCERM_DEFENCE_TYPES_FOLDED.has(foldDefenceType(feature.defenceType))) {
		throw new Error(
			`coastal build: ${feature.areaID} carries def_type ${JSON.stringify(feature.defenceType)}, which is not in the ` +
				"authority's declared defence domain even case-folded — the fold exists for the source's own inconsistent " +
				"capitalization, not to absorb a new defence type"
		)
	}
}
