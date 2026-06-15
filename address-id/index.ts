/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/address-id` — turn a canonicalized + geocoded address into a STABLE, parseable
 *   primary key: `<state>.<H3-cell>.<hash>`. The deterministic, exact-match complement to the fuzzy
 *   matcher (`@mailwoman/match`): where the matcher decides whether two messy records are probably
 *   the same entity, the address-id is a content-addressed key you can GROUP BY / JOIN ON without
 *   running the matcher at all — for the common "same canonical address" case.
 *
 *   The three parts (see {@link createPostalAddressID}):
 *
 *   - **state** — a coarse region prefix (`tx`, `ca`, …), from a supplied state or plucked from the
 *       address's ZIP ({@link @mailwoman/codex}); `xx` when unknown. Makes the key region-sortable.
 *   - **H3 cell** — a jitter-stable locality token from the resolved coordinate (`h3-js`'s
 *       `latLngToCell` at {@link ADDRESS_H3_RESOLUTION}). Coarse on purpose: two geocodes of the
 *       same place a few metres apart land in the same cell.
 *   - **hash** — a content hash of the address canonicalized by {@link @mailwoman/normalize} (so `123
 *       Main St` and `123 MAIN STREET` hash identically). This is the identity; the cell + state
 *       localize and partition it.
 *
 *   Lineage: the isp-nexus `createPostalAddressID` / `parsePostalAddressID`. `@mailwoman/normalize`
 *   is the descendant of that era's `sanitize`, re-scoped to parser-input prep — this layer is the
 *   keying purpose, kept separate by design. (Self-contained on `h3-js`, not `@mailwoman/spatial`,
 *   which isn't published.)
 */

import { us } from "@mailwoman/codex"
import { normalize } from "@mailwoman/normalize"
import { latLngToCell } from "h3-js"
import { createHash } from "node:crypto"

/** A geographic coordinate (the geocoder/resolver shape). */
export interface LatLng {
	latitude: number
	longitude: number
}

/**
 * H3 resolution for the locality cell — coarse on purpose (~edge 174 m). The same place geocoded a
 * few metres apart (situs vs interpolation, geocode jitter) lands in the same cell, so the key is
 * stable; the address hash carries the precise identity. Self-contained here (not via
 * `@mailwoman/spatial`, which isn't a published package) so this stays cleanly publishable.
 */
export const ADDRESS_H3_RESOLUTION = 9

/**
 * A stable address primary key, `<state>.<H3-cell>.<hash>`. Branded so it can't be confused with an
 * arbitrary string.
 */
export type PostalAddressID = string & { readonly __postalAddressID: unique symbol }

/** `<2-letter-state>.<hex-cell>.<hex-hash>` — lowercase, dot-delimited. */
const POSTAL_ADDRESS_ID_PATTERN = /^([a-z]{2})\.([0-9a-f]{1,15})\.([0-9a-f]{8,})$/

/**
 * Hex chars of the address content hash kept in the key (64 bits — collision-safe at billions of
 * keys).
 */
const HASH_LENGTH = 16

/** Inputs for {@link createPostalAddressID}. */
export interface CreatePostalAddressIDInput {
	/** The resolved coordinate (the geocoder's output) — drives the locality cell. */
	coordinate: LatLng
	/** The address string to content-hash. Canonicalized via {@link normalize} before hashing. */
	address: string
	/** 2-letter region/state for the prefix. When omitted, plucked from the address's ZIP; else `xx`. */
	state?: string
	/** H3 resolution for the cell. Default {@link ADDRESS_H3_RESOLUTION} (jitter-stable). */
	resolution?: number
}

/** The parsed parts of a {@link PostalAddressID}. */
export interface ParsedPostalAddressID {
	state: string
	cell: string
	hash: string
}

/**
 * Canonicalize an address for content-hashing: {@link normalize} (NFC + whitespace + punctuation +
 * abbreviation expansion) then uppercase, so casing/abbreviation/spacing variants key identically.
 */
function canonicalizeForHash(address: string): string {
	return normalize(address).normalized.toUpperCase().trim()
}

/**
 * Best-effort 2-letter US state from a full address: scan for `ST ZIP` occurrences (codex's
 * `pluckStateZIPCode` anchors to a bare snippet, so it can't read a full address) and take the LAST
 * valid one — addresses end with the state + ZIP. Returns the uppercase abbreviation or null.
 */
function deriveState(address: string): string | null {
	const candidates = [...address.matchAll(/\b([A-Za-z]{2})[ ,]+\d{5}(?:-\d{4})?\b/g)]
	for (let i = candidates.length - 1; i >= 0; i--) {
		const abbreviation = candidates[i]![1]!.toUpperCase()
		if (us.isUsStateAbbreviation(abbreviation)) return abbreviation
	}
	return null
}

/**
 * Build a stable {@link PostalAddressID} from a geocoded, canonicalizable address. Deterministic:
 * the same (coordinate-cell, canonical address, state) always yields the same key. Two records that
 * resolve to the same place and share a canonical address get the SAME id — a join/dedup key that
 * needs no matcher. (Distinct canonical address strings → distinct keys; semantic equivalence that
 * isn't string-identical is the fuzzy matcher's job, not this one's.)
 */
export function createPostalAddressID(input: CreatePostalAddressIDInput): PostalAddressID {
	const cell = latLngToCell(
		input.coordinate.latitude,
		input.coordinate.longitude,
		input.resolution ?? ADDRESS_H3_RESOLUTION
	)
	const hash = createHash("sha256").update(canonicalizeForHash(input.address)).digest("hex").slice(0, HASH_LENGTH)
	const state = (input.state ?? deriveState(input.address) ?? "xx").toLowerCase()
	return `${state}.${cell}.${hash}` as PostalAddressID
}

/** Parse a {@link PostalAddressID} into its parts, or null if it isn't one. */
export function parsePostalAddressID(id: string): ParsedPostalAddressID | null {
	const match = POSTAL_ADDRESS_ID_PATTERN.exec(id)
	if (!match) return null
	return { state: match[1]!, cell: match[2]!, hash: match[3]! }
}

/** Type guard: is `value` a well-formed {@link PostalAddressID}? */
export function isPostalAddressID(value: string): value is PostalAddressID {
	return POSTAL_ADDRESS_ID_PATTERN.test(value)
}
