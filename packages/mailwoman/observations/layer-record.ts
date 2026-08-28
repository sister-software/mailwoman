/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two records every layer designation carries on its way to a caller: which artifact answered, and what
 *   the coverage row said.
 *
 *   SHARED BY ALL FOUR LAYER ROUTES, because they are provenance rather than product. A reader holding a
 *   designation and not the artifact's identity cannot check the claim, and a reader holding a coverage
 *   magnitude without its BASIS cannot tell a cell an authority declares complete from one where a source
 *   happened to return rows. Four routes writing the same mapping is four places for one to drop the basis.
 */

import type { CoverageBasis, LayerManifest } from "@mailwoman/core/layers"

/**
 * Which artifact answered, and on what terms. Everything a reader needs to go and check the claim.
 */
export interface ObservationLayerRecord {
	name: string
	version: string
	tier: string
	license: string
	attribution?: string
	source: string
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	createdAt: string
}

/**
 * The coverage side of a designation, flattened for a marker's evidence.
 *
 * `basis` travels as a plain string because a marker's evidence is JSON a caller reads rather than a typed value it
 * branches on — but it is NEVER omitted: `completeness` alone is a magnitude, and the whole point of the contract's
 * `basis` column is that a magnitude cannot be acted on without it.
 */
export interface ObservationCoverageRecord {
	h3Cell: number
	h3CellIndex: string
	resolution: number
	basis: string
	completeness: number
	observedRows: number
}

/**
 * A layer's manifest as the record a designation carries.
 */
export function observationLayerRecord(manifest: LayerManifest): ObservationLayerRecord {
	return {
		name: manifest.name,
		version: manifest.version,
		tier: manifest.tier,
		license: manifest.license,
		...(manifest.attribution ? { attribution: manifest.attribution } : {}),
		source: manifest.source,
		sourceVintage: manifest.sourceVintage,
		buildCmd: manifest.buildCmd,
		buildSHA: manifest.buildSHA,
		createdAt: manifest.createdAt,
	}
}

/**
 * A reader's coverage row as the record a designation carries, or nothing where the reading had none.
 *
 * ABSENT RATHER THAN ZEROED where the layer holds no coverage row for the cell: a missing row means UNKNOWN, and a
 * record reading `completeness: 0` would say the opposite.
 */
export function observationCoverageRecord(
	coverage:
		| {
				h3Cell: number
				h3CellIndex: string
				resolution: number
				basis?: CoverageBasis
				completeness: number
				observedRows: number
		  }
		| undefined
): { coverage: ObservationCoverageRecord } | Record<string, never> {
	if (!coverage) return {}

	return {
		coverage: {
			h3Cell: coverage.h3Cell,
			h3CellIndex: coverage.h3CellIndex,
			resolution: coverage.resolution,
			basis: String(coverage.basis),
			completeness: coverage.completeness,
			observedRows: coverage.observedRows,
		},
	}
}
