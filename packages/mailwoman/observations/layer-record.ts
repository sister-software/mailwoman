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

/**
 * The coverage sentence a designation's one-line description carries — one wording for every layer, with the
 * completeness term added only where the layer's basis makes a completeness magnitude meaningful.
 */
export function describeCoverage(
	coverage: ObservationCoverageRecord | undefined,
	options: { completeness?: boolean } = {}
): string {
	if (!coverage) return "no coverage row"

	const base = `coverage cell ${coverage.h3CellIndex} (res ${coverage.resolution}) on basis "${coverage.basis}"`

	return options.completeness ? `${base} at completeness ${coverage.completeness.toFixed(4)}` : base
}

/**
 * The provenance sentence: which artifact answered, in one wording. `tier` widens it for a layer whose tier is part of
 * the claim (zoning ships `build-local`, and a reader must see that on the line).
 */
export function describeLayerProvenance(layer: ObservationLayerRecord, options: { tier?: boolean } = {}): string {
	const terms = options.tier ? `tier ${layer.tier}, license ${layer.license}` : layer.license

	return `from ${layer.name} ${layer.version} (${layer.source} ${layer.sourceVintage}, ${terms}, build ${layer.buildSHA})`
}

/**
 * What a designation route decided about one coordinate: an observation, or a named silence.
 */
export type LayerDesignationDecision<Observation, Refusal extends string> =
	| { fired: true; observation: Observation }
	| { fired: false; refusal: Refusal | "no_coordinate" }

export interface CreateDesignationRouteOptions<Reading, Observation, Refusal extends string> {
	/**
	 * Read the layer at one coordinate.
	 */
	read: (latitude: number, longitude: number) => Reading
	/**
	 * The named silence a reading maps to, or `undefined` where the reading fires.
	 */
	refusalFor: (reading: Reading) => Refusal | undefined
	/**
	 * Build the observation for a reading {@link CreateDesignationRouteOptions.refusalFor} let through.
	 */
	toObservation: (reading: Reading, latitude: number, longitude: number) => Observation
}

/**
 * The factory frame every designation route shares: the nullable-coordinate refusal (a geocode result carries
 * `lat`/`lon` as nullable, and a coordinate-less answer is a named refusal here rather than a caller's problem), the
 * reading-shaped refusal, and the disposal that closes the lookup.
 */
export function createDesignationRoute<Identity, Reading, Observation, Refusal extends string>(
	lookup: { identity: Identity } & Disposable,
	options: CreateDesignationRouteOptions<Reading, Observation, Refusal>
): {
	identity: Identity
	observe: (
		latitude: number | null | undefined,
		longitude: number | null | undefined
	) => LayerDesignationDecision<Observation, Refusal>
} & Disposable {
	return {
		identity: lookup.identity,
		observe: (latitude, longitude) => {
			if (typeof latitude !== "number" || typeof longitude !== "number") {
				return { fired: false, refusal: "no_coordinate" }
			}

			const reading = options.read(latitude, longitude)
			const refusal = options.refusalFor(reading)

			if (refusal) return { fired: false, refusal }

			return { fired: true, observation: options.toObservation(reading, latitude, longitude) }
		},
		[Symbol.dispose]: () => lookup[Symbol.dispose](),
	}
}
