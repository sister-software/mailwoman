/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Coverage rows and the area check shared by the polygon-layer builders.
 */

import { supportsExclusion, CoverageBasis } from "@mailwoman/evidence"

import type { CoverageCell } from "#layers/manifest"

/**
 * The coverage rows for a layer whose coverage is `source_present`: one per cell the authority's own polygons reach,
 * and none anywhere else.
 *
 * `observedRows` counts the polygons reaching the cell, which is what the contract's column means. There is no zero-row
 * cell here and there cannot be one: a cell with no polygon gets NO ROW, because a `source_present` layer publishes
 * nothing that would let an empty cell be distinguished from unmapped ground. A layer whose absence carries meaning
 * (flood's Zone 1) emits its rows from the designated extent instead, and does not use this.
 */
export function sourcePresentCoverageCells(observed: ReadonlyMap<number, number>): CoverageCell[] {
	const cells: CoverageCell[] = []

	for (const [h3Cell, observedRows] of observed) {
		cells.push({
			h3Cell,
			completeness: 1,
			basis: CoverageBasis.SourcePresent,
			observedRows,
		})
	}

	return cells.toSorted((left, right) => left.h3Cell - right.h3Cell)
}

/**
 * The coverage rows for a layer whose footprint an authority DESIGNATES: one per cell of the realized footprint, every
 * one at completeness 1 on the `designated` basis — `observed_rows` zero included, because a designated cell no polygon
 * reaches is the storable form of a designated absence, and the row a reader must not confuse with the absent row an
 * out-of-footprint cell has.
 *
 * @param options.include Narrows the footprint where a product excludes some cells — which cells, and what their
 *   exclusion means, is the product's own rule and stays at its call site.
 */
export function designatedCoverageCells(
	cells: Iterable<number>,
	observed: ReadonlyMap<number, number>,
	options: { include?: (h3Cell: number) => boolean } = {}
): CoverageCell[] {
	const rows: CoverageCell[] = []

	for (const h3Cell of cells) {
		if (options.include && !options.include(h3Cell)) continue

		rows.push({
			h3Cell,
			completeness: 1,
			basis: CoverageBasis.Designated,
			observedRows: observed.get(h3Cell) ?? 0,
		})
	}

	return rows.toSorted((left, right) => left.h3Cell - right.h3Cell)
}

/**
 * Refuse a coverage row that would license a NEGATIVE claim — the check the meaning-of-zero rule turns on for a
 * `source_present` layer, and a condition rather than a convention: the day someone writes a stronger basis without
 * settling the footprint question, the build refuses rather than letting an absent polygon be read as a designation.
 *
 * @param scope Names the caller in the refusal, e.g. `coastal build`.
 * @param limitSentence The product's own sentence saying why its coverage licenses no negative claim.
 */
export function assertNoNegativeClaim(scope: string, cells: ReadonlyArray<CoverageCell>, limitSentence: string): void {
	for (const cell of cells) {
		if (supportsExclusion(cell)) {
			throw new Error(
				`${scope}: coverage cell ${cell.h3Cell} carries basis ${JSON.stringify(cell.basis)}, which supports an EXCLUSION. ` +
					`${limitSentence} Until a mapped-footprint source is settled, every row must read ${CoverageBasis.SourcePresent}`
			)
		}
	}
}

/**
 * Refuse a layer holding no coverage rows at all — every location would read as unknown, and a reader cannot tell that
 * artifact from ground nobody mapped.
 *
 * @param indistinguishableFrom The product's own words for what the empty answer would be mistaken for.
 */
export function assertCoverageNotEmpty(rowCount: number, context: string, indistinguishableFrom: string): void {
	if (rowCount) return

	throw new Error(
		`${context} holds no coverage rows — every location would read as unknown, which is indistinguishable from ${indistinguishableFrom}`
	)
}

/**
 * Refuse a layer whose stored cells are finer than its manifest's declared index resolution.
 *
 * A stored cell finer than the declared index resolution has no ancestor chain from a probe's own cell, so
 * `cellToParent` would throw mid-query on some coordinates and not others. Refused at open time instead: it means the
 * manifest and the rows disagree about what the layer is, which is a build defect rather than a runtime condition.
 */
export function assertNoCellsFinerThanIndex(
	cellResolutions: readonly number[],
	indexResolution: number,
	context: string
): void {
	const finerThanIndex = cellResolutions.filter((resolution) => resolution > indexResolution)

	if (!finerThanIndex.length) return

	throw new Error(
		`${context} stores cells at resolution(s) ${finerThanIndex.join(", ")}, finer than the manifest's declared index resolution ${indexResolution} — the manifest and the rows disagree`
	)
}

/**
 * The measurement knobs every layer's resolution instrument shares. The driver loops stay per product: what a stream
 * yields, how scenarios partition it, and what each report carries genuinely differ.
 */
export interface ResolutionMeasurementOptions {
	/**
	 * The candidate resolutions to report.
	 */
	resolutions: readonly number[]
	onProgress?: (message: string) => void
	/**
	 * How often to report progress, in features.
	 */
	progressEvery?: number
}

/**
 * The area a build streamed, beside the area the source reports for itself.
 */
export interface AreaAgreement {
	/**
	 * The rings' total with holes subtracted.
	 */
	nestedKM2: number
	/**
	 * The publisher's own figure.
	 */
	sourceKM2: number
	/**
	 * The same rings read hole-blind, every ring as an exterior.
	 */
	allExteriorKM2: number
	/**
	 * `|nested − source| / source`.
	 */
	relativeGap: number
}

/**
 * The two totals a streaming ingest accumulates, in square metres of the encoded rings.
 */
export interface StreamedAreaTotals {
	nestedM2: number
	allExteriorM2: number
}

/**
 * Square metres in a square kilometre.
 */
const M2_PER_KM2 = 1_000_000

/**
 * An {@link AreaAgreement} whose witness is stated: either the source published a figure and the gap is against it, or
 * it published none and there is NOTHING TO AGREE WITH. The no-witness case is a TYPE rather than a zero, because a
 * `relativeGap` of 0 is indistinguishable from a pass, and a check that never ran must not read as one.
 */
export type AreaAgreementReading =
	| (AreaAgreement & { witness: "source" })
	| {
			witness: "absent"
			nestedKM2: number
			allExteriorKM2: number
	  }

/**
 * Both readings of a build's streamed ring areas against the source's own figure — or the stated absence of one.
 */
export function areaAgreementFrom(streamed: StreamedAreaTotals, sourceM2: number | undefined): AreaAgreementReading {
	const nestedKM2 = streamed.nestedM2 / M2_PER_KM2
	const allExteriorKM2 = streamed.allExteriorM2 / M2_PER_KM2

	if (!sourceM2) {
		return { witness: "absent", nestedKM2, allExteriorKM2 }
	}

	return {
		witness: "source",
		nestedKM2,
		allExteriorKM2,
		sourceKM2: sourceM2 / M2_PER_KM2,
		relativeGap: Math.abs(streamed.nestedM2 - sourceM2) / sourceM2,
	}
}

/**
 * Refuse an artifact whose rings do not add up to the area the source itself reports. A reading with no witness has
 * nothing to disagree with and passes through — its type is what keeps that from reading as a pass.
 *
 * The message carries the hole-blind total beside the nested one, because the gap between them is the diagnosis: a hole
 * read as an exterior ring answers "inside" for every point in it.
 *
 * @param scope Names the builder in the error, e.g. `coastal build`.
 */
export function assertAreaAgreement(scope: string, area: AreaAgreementReading, tolerance: number): void {
	if (area.witness === "absent") return

	if (area.relativeGap <= tolerance) return

	throw new Error(
		`${scope}: the encoded rings total ${area.nestedKM2.toFixed(1)} km² against the source's ${area.sourceKM2.toFixed(1)} km² ` +
			`(${(area.relativeGap * 100).toFixed(2)}% apart, tolerance ${(tolerance * 100).toFixed(0)}%). Read without their holes the same rings total ` +
			`${area.allExteriorKM2.toFixed(1)} km², so compare the two: a hole-blind read answers "inside" for every point in a hole`
	)
}
