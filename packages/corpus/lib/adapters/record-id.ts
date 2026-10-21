/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A row's `source_id` as a record id plus a per-row discriminator, `<record id>#<discriminator>`.
 *
 *   A renderer or adapter can write several texts for one record: a German tuple drawn twice with a
 *   different Ortsteil, a library system whose outlets share one key. Each row then needs its own
 *   identity, because a split attribute and a deletion name rows by `source_id`, while the overlap
 *   audit, the held-out freeze and the val/test bucket group rows by their record. The part before the
 *   last `#` is the record id, and the part after it tells the rows of one record apart (#2765).
 *
 *   An augmentation appends `+<method>` to the id it derives from, so `<record>#<discriminator>+case-lower`
 *   still reads back as `<record>`.
 */

import { sha256Hex } from "@mailwoman/core/hash"

/**
 * The separator between a record's id and the per-row discriminator.
 */
export const ROW_ID_SEPARATOR = "#"

/**
 * The `source_id` of one row of a record: `<recordID>#<discriminator>`.
 *
 * @throws When the record id already holds the separator or the discriminator is empty.
 */
export function rowSourceID(recordID: string, discriminator: string): string {
	if (recordID.includes(ROW_ID_SEPARATOR)) {
		throw new Error(`record id ${recordID} already holds "${ROW_ID_SEPARATOR}", so its record could not be read back`)
	}

	if (!discriminator) throw new Error(`record id ${recordID} was given an empty row discriminator`)

	return `${recordID}${ROW_ID_SEPARATOR}${discriminator}`
}

/**
 * The discriminator drawn from a row's text: the first 12 hex characters of `sha256(raw)`.
 *
 * Two rows of one record with the same text get the same discriminator.
 * A writer using it skips a text it has already written for that record.
 */
export function rawTextDiscriminator(raw: string): string {
	return sha256Hex(raw).slice(0, 12)
}

/**
 * The row ids one renderer run has written, each `<record id>#<raw-text discriminator>`.
 *
 * A renderer that draws its records with replacement renders some record and text twice.
 * The second copy would repeat both the text and the id, so {@linkcode RenderedRowIDs.claim} refuses it.
 */
export class RenderedRowIDs {
	#written = new Set<string>()

	/**
	 * The id for a row of `recordID` with text `raw`, or `null` when this run already wrote that row.
	 */
	claim(recordID: string, raw: string): string | null {
		const id = rowSourceID(recordID, rawTextDiscriminator(raw))

		if (this.#written.has(id)) return null

		this.#written.add(id)

		return id
	}
}

/**
 * The record a `source_id` belongs to: the part before the last `#`, or the whole id when it holds none.
 */
// repo-health-ignore export-name-affix -- This removes a corpus row discriminator.
// Stripe's idOf reads an expandable object ID.
export function recordIDOf(sourceID: string): string {
	const at = sourceID.lastIndexOf(ROW_ID_SEPARATOR)

	return at === -1 ? sourceID : sourceID.slice(0, at)
}

/**
 * {@linkcode recordIDOf} as a DuckDB expression over a `VARCHAR` column expression.
 */
export function recordIDSQL(column: string): string {
	return `regexp_replace(${column}, '${ROW_ID_SEPARATOR}[^${ROW_ID_SEPARATOR}]*$', '')`
}
