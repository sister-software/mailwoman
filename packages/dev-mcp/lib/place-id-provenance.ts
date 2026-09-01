/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which SOURCE a gazetteer place id came from, and therefore whether it is a real Who's On First id.
 *
 *   `spr` is WOF's own table name — Standard Place Response, the flat one-row-per-place projection they ship
 *   beside the GeoJSON — and we keep their schema, so `spr.id` IS the WOF id for a WOF-sourced row. It is not
 *   for the rest: the Overture and GeoNames folds mint SYNTHETIC ids in reserved ranges above every real WOF
 *   id, and those look exactly like WOF ids while resolving to nothing on spelunker.
 *
 *   Every place row a maintainer tool emits therefore carries {@link PlaceIDProvenance}, because the failure
 *   this prevents is silent: an id is pasted into spelunker, 404s, and reads as "our gazetteer invented a
 *   place" rather than "this place came from Overture". Turkey's `Of` is the case that prompted it —
 *   8114738869649 and 8837168432019 are Overture divisions, while WOF's own `Of` is 890463199 and carries a
 *   DIFFERENT population (31,951 against Overture's 44,212 on both rows).
 */

import { GEONAMES_ID_BASE } from "@mailwoman/resolver-wof-sqlite/geonames-aliases"
import { GEONAMES_POSTAL_ID_BASE } from "@mailwoman/resolver-wof-sqlite/geonames-postal"
import { OVERTURE_ID_BASE } from "mailwoman/gazetteer-pipeline/admin/fold-overture"

/**
 * Where a place id was minted. Each value names the fold that owns the range, never the placetype or country.
 */
export const PlaceIDSource = {
	/**
	 * A real Who's On First id, below every synthetic base. Resolvable on spelunker.
	 */
	WOF: "wof",
	/**
	 * Minted by the Overture `divisions` backfill for a locale with no WOF repo (`assignSyntheticIDs` hashes the GERS id
	 * into the reserved span). Not a WOF id.
	 */
	Overture: "overture",
	/**
	 * Minted by the GeoNames alias fold. Not a WOF id.
	 */
	GeoNames: "geonames",
	/**
	 * Minted by the GeoNames POSTAL fold, which reserves its own span above the alias fold. Not a WOF id.
	 */
	GeoNamesPostal: "geonames-postal",
} as const

export type PlaceIDSource = (typeof PlaceIDSource)[keyof typeof PlaceIDSource]

/**
 * The provenance of one place id.
 */
export interface PlaceIDProvenance {
	/**
	 * Which fold minted it.
	 */
	id_source: PlaceIDSource
	/**
	 * The id AS a Who's On First id, or `null` when it is synthetic. Null here is a positive statement — "this place has
	 * no WOF identity" — and is why the field is emitted even when it is null rather than omitted.
	 */
	wof_id: number | null
	/**
	 * The spelunker permalink, or `null` for a synthetic id. Present so a reader never has to know the URL shape, and
	 * absent so they never paste one that 404s.
	 */
	wof_url: string | null
}

/**
 * Classify a place id by the range it falls in.
 *
 * The ranges are read from the folds that mint them rather than re-declared, so a fold that moves its base moves this
 * classifier with it. They are contiguous and ascending — WOF below {@link OVERTURE_ID_BASE}, then Overture, then the
 * GeoNames alias fold at {@link GEONAMES_ID_BASE}, then the GeoNames postal fold at {@link GEONAMES_POSTAL_ID_BASE} —
 * so a single ladder classifies every id with no gap and no overlap.
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
 * The note a result set carries when it holds at least one synthetic id, naming the counts per source.
 *
 * Returns `undefined` when every id is a real WOF id: a note that fires unconditionally is one a reader learns to skip,
 * and the interesting state here is the mixed set.
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
