/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The per-place record every candidate-staging pass writes its rows from.
 *
 *   Pass 1 reduces each current `spr` row to one {@link PlaceAttrs}; every later pass (alias bags,
 *   region abbreviations, country display names, the currency backfill, the shard folds) discovers
 *   ADDITIONAL name keys for a place already in that map and stages a row against the same record.
 *   That is what keeps each candidate row denormalized without re-reading the source, and it is why
 *   a pass needs exactly four things to stage: the key it found, the place, the id the row hangs on,
 *   and whether the key is the place's canonical name.
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
	pop: number
	neg: number
	pkey: string
	/**
	 * The place's toponym-fame score, or null when the score source has no measurement for it (#28). A property of the
	 * PLACE, so it rides {@link StageRow} onto the alias and abbrev rows too — that is how a bare `Moscow` reaches
	 * Москва's score through the alias row that carries the key.
	 */
	imp: number | null
}

/**
 * Stage one candidate row: a normalized name key, the place it belongs to, the source id the row hangs on, and whether
 * the key is that place's canonical name (`is_primary`).
 *
 * `sid` is passed separately rather than read off the place because a shard fold and the alias pass stage rows for ids
 * the admin `attrs` map never held.
 */
export type StageRow = (k: string, a: PlaceAttrs, sid: number, isPrimary: number) => void
