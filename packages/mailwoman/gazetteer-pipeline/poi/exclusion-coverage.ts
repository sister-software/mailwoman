/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compose a region outline, one class's rows from two inventories, and a capture-recapture estimate into
 *   the coverage cells a layer writes — the only path in this pipeline that reaches
 *   {@link CoverageBasis.Surveyed}.
 *
 *   Pure. The IO (ogr2ogr for the outline and the OSM rows, SQLite for the reference inventory) belongs to
 *   the command; everything decided here is decided from data already in memory, so the arithmetic behind a
 *   completeness claim is testable over synthetic points.
 *
 *   Three rules hold the claim to its evidence:
 *
 *   1. **Every interior cell gets a row, including the empty ones.** A cell with `observedRows: 0` under a
 *      surveyed basis is the storable form of "surveyed, and there is none here" — the whole reason
 *      exclusion-grade coverage exists. A cell left OUT of the table means unknown, and the two must never
 *      collapse into each other.
 *   2. **Cells outside the region are never written.** Not at completeness 0, not at all: the region is
 *      what was measured, and the measurement says nothing about its outside.
 *   3. **One region, one completeness.** The estimate is regional, so it is recorded regionally rather than
 *      dressed up as per-cell precision it does not have. Per-cell variation needs a per-cell denominator;
 *      measured against the pilot's own départements the pooled and stratified populations agreed to within
 *      0.7% (4,055 vs 4,042 under the primary protocol), which is what licenses the uniform value HERE and
 *      is not a result that transfers to another region unmeasured.
 */

import { CoverageBasis } from "@mailwoman/core/layers"
import { POI_H3_RESOLUTION } from "@mailwoman/resolver-wof-sqlite/poi-lookup"
import { shortCellToInt, type GeojsonGeometry, type H3Cell } from "@mailwoman/spatial"
import { cellToParent, latLngToCell } from "h3-js"

import {
	completenessAcrossProtocols,
	MATCH_PROTOCOL_GRID,
	type CaptureRow,
	type CoverageCompleteness,
	type MatchProtocol,
} from "./capture-recapture.ts"
import { interiorCoverageCells } from "./coverage-region.ts"

export interface ExclusionCoverageCell {
	h3Cell: number
	observedRows: number
	completeness: number
	basis: CoverageBasis
}

export interface ExclusionCoverageInput {
	/**
	 * The region outline the claim is keyed to.
	 */
	geometry: GeojsonGeometry
	/**
	 * Resolution of the coverage cells. Match the layer being written, or a reader keyed to the other resolution finds
	 * nothing and reads that as unsurveyed.
	 */
	resolution: number
	/**
	 * The inventory the layer being built is made of — the one whose completeness is recorded.
	 */
	subject: readonly CaptureRow[]
	/**
	 * The independent inventory the subject is measured against.
	 */
	reference: readonly CaptureRow[]
	grid?: readonly MatchProtocol[]
}

export interface ExclusionCoverageResult {
	cells: ExclusionCoverageCell[]
	/**
	 * Interior cells holding no subject row — the exclusion payload, and the count worth reading first.
	 */
	emptyCells: number
	/**
	 * Subject rows that fell outside the interior cell set and are therefore not represented in coverage.
	 */
	subjectOutsideRegion: number
	referenceOutsideRegion: number
	completeness: CoverageCompleteness
}

/**
 * The coverage cell a row belongs to.
 *
 * Derived as `cellToParent(res-9 cell)` rather than by a direct `latLngToCell` at the coverage resolution, matching
 * `bboxCoverageCells` and every reader. H3's hierarchy is not geometrically exact, so the two derivations disagree for
 * a real fraction of points, and a row landing on a neighbouring cell here would move an observed count off the cell it
 * was observed in.
 */
function coverageCellOf(row: CaptureRow, resolution: number): number {
	const rowCell = latLngToCell(row.latitude, row.longitude, POI_H3_RESOLUTION) as H3Cell

	return shortCellToInt(cellToParent(rowCell, resolution) as H3Cell)
}

/**
 * Split an inventory into the part inside `interior` (keyed by coverage cell) and the count that fell outside.
 */
function clipToRegion(
	rows: readonly CaptureRow[],
	interior: ReadonlySet<number>,
	resolution: number
): { inside: CaptureRow[]; cellCounts: Map<number, number>; outside: number } {
	const inside: CaptureRow[] = []
	const cellCounts = new Map<number, number>()
	let outside = 0

	for (const row of rows) {
		if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) {
			outside++

			continue
		}

		const cell = coverageCellOf(row, resolution)

		if (!interior.has(cell)) {
			outside++

			continue
		}

		inside.push(row)
		cellCounts.set(cell, (cellCounts.get(cell) ?? 0) + 1)
	}

	return { inside, cellCounts, outside }
}

/**
 * Measure the subject inventory's completeness against the reference, and emit one surveyed coverage cell per interior
 * cell of the region.
 */
export function buildExclusionCoverage(input: ExclusionCoverageInput): ExclusionCoverageResult {
	const interiorCells = interiorCoverageCells(input.geometry, input.resolution)

	if (!interiorCells.length) {
		throw new Error(
			`buildExclusionCoverage: no res-${input.resolution} cell lies wholly inside the region — the region is ` +
				`smaller than one cell at this resolution, so no cell can carry a claim about it`
		)
	}

	const interior = new Set(interiorCells.map((cell) => shortCellToInt(cell)))
	const subject = clipToRegion(input.subject, interior, input.resolution)
	const reference = clipToRegion(input.reference, interior, input.resolution)

	const completeness = completenessAcrossProtocols(reference.inside, subject.inside, input.grid ?? MATCH_PROTOCOL_GRID)

	const cells = [...interior].map((h3Cell) => ({
		h3Cell,
		observedRows: subject.cellCounts.get(h3Cell) ?? 0,
		completeness: completeness.recorded,
		basis: CoverageBasis.Surveyed,
	}))

	return {
		cells,
		emptyCells: cells.filter((cell) => cell.observedRows === 0).length,
		subjectOutsideRegion: subject.outside,
		referenceOutsideRegion: reference.outside,
		completeness,
	}
}
