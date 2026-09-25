/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Classifies a gazetteer place ID by the source that minted it.
 *
 *   `spr.id` is a real Who's On First ID only for WOF rows. The Overture and GeoNames folds mint synthetic IDs
 *   in reserved ranges above every WOF ID, and those IDs do not resolve on spelunker.
 */

import {
	GEONAMES_ID_BASE,
	GEONAMES_POSTAL_ID_BASE,
	OVERTURE_ID_BASE,
} from "@mailwoman/core/resolver/synthetic-id-ranges"

/**
 * The fold that minted a place ID.
 */
export const PlaceIDSource = {
	/**
	 * A real Who's On First ID, below every synthetic base.
	 * It resolves on spelunker.
	 */
	WOF: "wof",
	/**
	 * A synthetic ID from the Overture `divisions` backfill, which hashes the GERS ID into its reserved range.
	 */
	Overture: "overture",
	/**
	 * A synthetic ID from the GeoNames alias fold.
	 */
	GeoNames: "geonames",
	/**
	 * A synthetic ID from the GeoNames postal fold, whose range sits above the alias fold's.
	 */
	GeoNamesPostal: "geonames-postal",
} as const

/**
 * One place ID source.
 */
export type PlaceIDSource = (typeof PlaceIDSource)[keyof typeof PlaceIDSource]

/**
 * The provenance of one place ID.
 */
export interface PlaceIDProvenance {
	id_source: PlaceIDSource
	/**
	 * The ID as a Who's On First ID, or `null` when it is synthetic.
	 * The field is always present.
	 */
	wof_id: number | null
	/**
	 * The spelunker permalink, or `null` for a synthetic ID.
	 */
	wof_url: string | null
}

/**
 * Classifies a place ID by the range it falls in.
 *
 * The range bases come from the modules that mint the IDs.
 * The ranges are contiguous and ascending: WOF, then Overture, then GeoNames aliases,
 * then GeoNames postal codes.
 */
export function placeIDProvenance(id: number): PlaceIDProvenance {
	if (id >= GEONAMES_POSTAL_ID_BASE) {
		return { id_source: PlaceIDSource.GeoNamesPostal, wof_id: null, wof_url: null }
	}

	if (id >= GEONAMES_ID_BASE) return { id_source: PlaceIDSource.GeoNames, wof_id: null, wof_url: null }

	if (id >= OVERTURE_ID_BASE) return { id_source: PlaceIDSource.Overture, wof_id: null, wof_url: null }

	return { id_source: PlaceIDSource.WOF, wof_id: id, wof_url: `https://spelunker.whosonfirst.org/id/${id}` }
}

/**
 * Returns a note with the count of synthetic IDs per source.
 *
 * @returns `undefined` when every ID is a real WOF ID.
 */
export function syntheticIDNote(ids: readonly number[]): string | undefined {
	const counts = new Map<PlaceIDSource, number>()

	for (const id of ids) {
		const { id_source } = placeIDProvenance(id)
		counts.set(id_source, (counts.get(id_source) ?? 0) + 1)
	}

	const synthetic = [...counts].filter(([source]) => source !== PlaceIDSource.WOF)

	if (!synthetic.length) return undefined

	const parts = synthetic.map(([source, n]) => `${n} ${source}`).join(", ")

	return (
		`${parts} — those ids are SYNTHETIC, minted by a fold in a reserved range above every real WOF id, and they ` +
		"resolve to nothing on spelunker. `wof_id` is null on exactly those rows; a row with a non-null `wof_id` is a " +
		"real Who's On First record and `wof_url` links it."
	)
}
