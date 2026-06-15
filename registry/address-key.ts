/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The address-id consumer for the matcher (#259). Derives a stable {@link PostalAddressID} from a
 *   resolved {@link SourceRecord} and exposes it as a blocking key — the deterministic,
 *   exact-canonical-address complement to the fuzzy Fellegi-Sunter / GBT scoring. Two uses:
 *
 *   - **As a pre-dedup / join key:** `GROUP BY postalAddressId(record)` collapses records that resolve
 *       to the same place AND share a canonical address with NO scoring at all — the cheap, certain
 *       slice of dedup before the matcher does the fuzzy rest.
 *   - **As a blocking key:** {@link addressIdBlockingKey} adds the address-id to the blocking union, so
 *       records sharing one are guaranteed to be compared.
 */

import { createPostalAddressID, type PostalAddressID } from "@mailwoman/address-id"
import { type BlockingKey, exactKey } from "@mailwoman/match"
import type { SourceRecord } from "./types.js"

/**
 * The stable address primary key for a record, or null when it isn't geocoded (no coordinate → no
 * locality cell) or carries no raw address to hash. Uses the resolved coordinate + the raw address;
 * the state prefix is plucked from the address when present.
 */
export function postalAddressId(record: SourceRecord): PostalAddressID | null {
	const coordinate = record.address?.geocode?.coordinate
	const address = record.address?.raw
	if (!coordinate || !address) return null
	return createPostalAddressID({ coordinate, address })
}

/**
 * A blocking key on the {@link postalAddressId} — records that resolve to the same place with the
 * same canonical address block together. Add it to {@link defaultBlockingKeys}'s union when an exact
 * address join should never be missed.
 */
export function addressIdBlockingKey(): BlockingKey<SourceRecord> {
	return exactKey((record) => postalAddressId(record))
}
