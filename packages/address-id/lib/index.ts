/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/address-id` builds a stable key from a normalized, geocoded address:
 *   `<state>.<H3-cell>.<hash>`.
 *
 *   Parts (see {@link createPostalAddressID}):
 *
 *   - **state** — 2-letter region prefix (`tx`, `ca`, ...), from input state or ZIP; `xx` if unknown.
 *   - **H3 cell** — coarse location from coordinates (`latLngToCell` at {@link ADDRESS_H3_RESOLUTION}).
 *   - **hash** — hash of the normalized address text. This part identifies the address.
 *
 */

import { us } from "@mailwoman/codex"
import { sha256Hex } from "@mailwoman/core/hash"
import { normalize } from "@mailwoman/normalize"
import type { GeoCoordinate } from "@mailwoman/spatial"
import { latLngToCell } from "h3-js"

/**
 * H3 resolution for the location cell (~174 m edge).
 * Kept coarse so small geocode jitter stays in the same cell.
 */
export const ADDRESS_H3_RESOLUTION = 9

/**
 * A stable address primary key, `<state>.<H3-cell>.<hash>`.
 * Branded so it is not confused with a plain string.
 */
export type PostalAddressID = string & { readonly __postalAddressID: unique symbol }

/**
 * `<2-letter-state>.<hex-cell>.<hex-hash>` — lowercase, dot-delimited.
 */
const POSTAL_ADDRESS_ID_PATTERN = /^([a-z]{2})\.([0-9a-f]{1,15})\.([0-9a-f]{8,})$/

/**
 * Number of hex chars from the address hash to keep in the key (64 bits).
 */
const HASH_LENGTH = 16

/**
 * Inputs for {@link createPostalAddressID}.
 */
export interface CreatePostalAddressIDInput {
	/**
	 * Resolved coordinate from the geocoder.
	 */
	coordinate: GeoCoordinate
	/**
	 * Address string to hash (normalized first).
	 */
	address: string
	/**
	 * 2-letter state/region prefix.
	 *
	 * Derive it from ZIP when omitted.
	 * Use `xx` when no state can be derived.
	 */
	state?: string | null
	/**
	 * H3 resolution for the cell.
	 * Defaults to {@link ADDRESS_H3_RESOLUTION}.
	 */
	resolution?: number | null
}

/**
 * The parsed parts of a {@link PostalAddressID}.
 */
export interface ParsedPostalAddressID {
	state: string
	cell: string
	hash: string
}

/**
 * Canonicalize address text for hashing.
 *
 * The function normalizes and uppercases the text.
 * It then trims the ends.
 * These steps make common format differences hash the same.
 */
function canonicalizeForHash(address: string): string {
	return normalize(address).normalized.toUpperCase().trim()
}

/**
 * Best-effort US state from a full address.
 * Finds `ST ZIP` patterns and uses the last valid match.
 *
 * @returns the uppercase abbreviation or null.
 */
function deriveState(address: string): string | null {
	const candidates = [...address.matchAll(/\b([A-Za-z]{2})[ ,]+\d{5}(?:-\d{4})?\b/g)]

	for (let i = candidates.length - 1; i >= 0; i--) {
		const abbreviation = candidates[i]![1]!.toUpperCase()

		if (us.isUSStateAbbreviation(abbreviation)) return abbreviation
	}

	return null
}

/**
 * Build a stable {@link PostalAddressID} from a geocoded, canonicalizable address.
 *
 * Same cell + canonical address + state always gives the same key.
 */
export function createPostalAddressID(input: CreatePostalAddressIDInput): PostalAddressID {
	const cell = latLngToCell(
		input.coordinate.latitude,
		input.coordinate.longitude,
		input.resolution ?? ADDRESS_H3_RESOLUTION
	)

	const hash = sha256Hex(canonicalizeForHash(input.address)).slice(0, HASH_LENGTH)
	const state = (input.state ?? deriveState(input.address) ?? "xx").toLowerCase()

	return `${state}.${cell}.${hash}` as PostalAddressID
}

/**
 * Parse a {@link PostalAddressID}, or return null if invalid.
 */
export function parsePostalAddressID(id: string): ParsedPostalAddressID | null {
	const match = POSTAL_ADDRESS_ID_PATTERN.exec(id)

	if (!match) return null

	return { state: match[1]!, cell: match[2]!, hash: match[3]! }
}

/**
 * Type guard for a well-formed {@link PostalAddressID}.
 */
export function isPostalAddressID(value: string): value is PostalAddressID {
	return POSTAL_ADDRESS_ID_PATTERN.test(value)
}
