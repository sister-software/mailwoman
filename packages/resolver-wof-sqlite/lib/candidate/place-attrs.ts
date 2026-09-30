/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The per-place record every candidate-staging pass writes its rows from.
 *
 *   Pass 1 reduces each current `spr` row to one {@link PlaceAttrs}. Every later pass (alias bags,
 *   region abbreviations, country display names, the currency backfill, the extract folds) discovers
 *   additional name keys for a place already in that map and stages a row against the same record.
 *   That keeps each candidate row denormalized without re-reading the source. A pass therefore needs
 *   exactly four values: the key, place, row ID, plus a flag for the place's canonical name.
 */

export interface PlaceAttrs {
	cid: number
	rid: number
	ptid: number
	name: string
	lat: number
	lon: number
	mnLat: number
	mnLon: number
	mxLat: number
	mxLon: number
	/**
	 * The place's recorded population, or null when the gazetteer never measured one.
	 *
	 * NULL rather than zero.
	 * `place_population` holds no zero, so an absent row is the only way a place has no number.
	 * A zero written for those would be an unmeasured count.
	 */
	pop: number | null
	neg: number
	pkey: string
	/**
	 * The place's toponym-fame score, or null when the score source has no measurement for it.
	 *
	 * A property of the place, so it appears on {@link StageRow} and on alias and abbrev rows too.
	 * That is how a bare `Moscow` reaches Москва's score through the alias row that includes the key.
	 */
	imp: number | null
}

/**
 * Stages one candidate row with a normalized name key, place, source ID,
 * plus a canonical-name flag (`is_primary`).
 *
 * `sid` is passed separately rather than read off the place because an extract fold
 * and the alias pass stage rows for ids the admin `attrs` map never held.
 */
export type StageRow = (k: string, a: PlaceAttrs, sid: number, isPrimary: number) => void
