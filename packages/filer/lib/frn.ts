/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Branded type and validation for FCC Registration Numbers (FRNs), which are 10-digit zero-padded strings.
 */

import type { Tagged } from "type-fest"

/**
 * FCC CORES identifier represented as a zero-padded 10-digit string, e.g. `"0001753557"`.
 */
export type FRN = Tagged<string, "FRN">

const FRN_PATTERN = /^\d{10}$/

/**
 * Check that the value contains exactly 10 ASCII digits.
 */
export function isFRN(value: unknown): value is FRN {
	return typeof value === "string" && FRN_PATTERN.test(value)
}

/**
 * Normalize a numeric or string candidate to a 10-digit FRN, or return `null` if invalid.
 */
export function toFRN(value: string | number): FRN | null {
	const raw = typeof value === "number" ? String(value) : value.trim()

	if (!/^\d+$/.test(raw)) return null

	const padded = raw.padStart(10, "0")

	return isFRN(padded) ? padded : null
}
