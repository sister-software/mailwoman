/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The per-record geocode step, factored out of the worker so it unit-tests against a fake seam (no
 * neural model / SQLite). `geocode-worker.ts` builds the real seam from config and wraps this.
 */

import { type ColumnMapping, type GeocodeAddress, pick } from "./ingest.js"
import type { SourceRecord } from "./types.js"

/**
 * Build the handler `geocodeStream` runs per normalized record: recompute the joined address string from `record.raw` +
 * `mapping.address` (the worker can't receive the original closure), geocode it via `seam`, and attach the result.
 * Records with no mapped address pass through untouched (no geocode call). The default separator matches
 * {@link ingestRow}'s `addressSeparator`.
 */
export function makeGeocodeHandler(
	seam: GeocodeAddress,
	mapping: ColumnMapping,
	addressSeparator = ", "
): (record: SourceRecord) => Promise<SourceRecord> {
	return async (record) => {
		if (!record.raw) return record

		const addressValue = pick(record.raw, mapping.address, addressSeparator)

		if (!addressValue) return record

		const address = (await seam(addressValue)) ?? undefined

		return { ...record, address }
	}
}
