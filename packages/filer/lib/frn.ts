/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC Registration Number (FRN) branded type (3a decision 3).
 *
 *   Re-homed from Nexus's `fcc/entity/frn.ts` (relicense-by-copy, no provenance headers), retyped
 *   per decision 3: Nexus modeled `FRN` as `Tagged<number, "FRN">`, which silently drops leading
 *   zeros — the same defect class as 2a's `location_id` (see `bdc/sdk/parsing.ts`). The FCC's FRN is
 *   always a 10-digit, zero-padded string (e.g. `"0001753557"`), so it's branded over `string` here
 *   instead, and `BDCProviderTable.frn` (already `string | null`) agrees with this shape.
 *
 *   {@linkcode isFRN} also fixes a real laxity in the Nexus guard, which only checked that the value
 *   parsed to a non-negative, finite number — a bare `"1753557"` (7 digits, unpadded) passed it
 *   despite not being a real FRN. This guard checks the actual 10-digit, zero-padded shape.
 */

import type { Tagged } from "type-fest"

/**
 * Also known as a CORES ID: a unique identifier for an entity in the FCC's CORES system. Always a zero-padded 10-digit
 * string — e.g. `"0001753557"`, never the bare number `1753557`.
 */
export type FRN = Tagged<string, "FRN">

const FRN_PATTERN = /^\d{10}$/

/**
 * Predicate for a valid FRN: exactly 10 ASCII digits, zero-padded. Deliberately stricter than the Nexus original
 * (`isp-nexus/universe/fcc/entity/frn.ts`), which only checked `parseInt`-ability, non-negativity, and finiteness.
 */
export function isFRN(value: unknown): value is FRN {
	return typeof value === "string" && FRN_PATTERN.test(value)
}

/**
 * Zero-pads a numeric or string FRN candidate to the canonical 10-digit form and validates it. Returns `null` (never
 * throws) for anything that isn't a non-negative integer fitting in 10 digits — an FRN missing or malformed on an
 * otherwise well-formed Form 499 row is common and unremarkable (see `form499.ts`'s {@linkcode Form499Row.frn}), not the
 * "malformed row" error decision 8 guards against.
 */
export function toFRN(value: string | number): FRN | null {
	const raw = typeof value === "number" ? String(value) : value.trim()

	if (!/^\d+$/.test(raw)) return null

	const padded = raw.padStart(10, "0")

	return isFRN(padded) ? padded : null
}
