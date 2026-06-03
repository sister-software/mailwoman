/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Japanese postal codes (郵便番号, yūbin-bangō): the branded type, the shape, normalization, and the
 *   first-digit → coarse-region prior.
 *
 *   This file is the far end of a spectrum whose other end is `us/zipcode.ts`. A US address leans on
 *   the street line — a named street plus a house number — and the ZIP is a routing convenience. A
 *   Japanese address is the inverse on two counts:
 *
 *   - It is written **largest-to-smallest**: prefecture → city/ward → district → block → lot (`東京都 千代田区
 *       千代田 1-1`), the reverse of the US smallest-to-largest line order.
 *   - There are **essentially no street names**. Outside a few Kyoto-style exceptions, you do not
 *       navigate by named streets; you navigate by nested administrative areas and numbered
 *       blocks/lots (丁目 / 番地 / 号 — see `address-unit.ts`).
 *
 *   With no street name to anchor on and a reverse field order, the **postal code is the single most
 *   reliable geographic anchor** for a Japanese address — it pins the chōme-level area directly,
 *   far tighter than a US ZIP pins a US address. So where the US parser treats the postcode as a
 *   tie-breaker behind the street, the Japan parser should treat it as the primary key.
 */

import type { Tagged } from "type-fest"

/**
 * A Japanese postal code: three digits, a hyphen, then four digits (`100-0001`), conventionally
 * written after the 〒 mark (`〒100-0001`). Branded so a normalized code is distinct from an
 * arbitrary string — the 7-digit shape alone does not prove a code is real, only well-formed.
 *
 * @category Postal
 * @type string
 * @title 郵便番号
 * @pattern ^\d{3}-?\d{4}$
 */
export type PostalCode = Tagged<string, "JpPostalCode">

/** The postal-code shape: `NNN-NNNN`, the hyphen optional on input (`1000001` or `100-0001`). */
export const JP_POSTAL_CODE_PATTERN = /^\d{3}-?\d{4}$/

/**
 * Normalize a postal-code surface form to the canonical hyphenated `NNN-NNNN`: strip a leading 〒
 * mark and any whitespace, then re-insert the hyphen if the input gave the bare seven digits
 * (`〒100-0001` → `100-0001`, `1000001` → `100-0001`). Returns null if the result is not seven
 * digits.
 */
export function normalizeJpPostalCode(raw: unknown): PostalCode | null {
	if (typeof raw !== "string") return null
	// Drop the 〒 mark and all whitespace, then keep only the digits.
	const digits = raw.replace(/〒/g, "").replace(/\s+/g, "").replace(/-/g, "")
	if (!/^\d{7}$/.test(digits)) return null
	return `${digits.slice(0, 3)}-${digits.slice(3)}` as PostalCode
}

/** Type-predicate for a Japanese postal code (hyphen optional, `100-0001` or `1000001`). */
export function isJpPostalCode(input: unknown): input is PostalCode {
	return typeof input === "string" && JP_POSTAL_CODE_PATTERN.test(input)
}

/**
 * First digit of the postal code → a coarse region label. Japan Post's numbering grows roughly
 * outward from Tokyo (`1xx`) and is **approximate** at this granularity — a single leading digit
 * spans large, irregular areas and the boundaries are postal-routing, not administrative. Use it as
 * a weak prior, never as a hard region assignment; the full code is what actually anchors the
 * address.
 *
 * Approximate — the labels below are illustrative routing regions, not precise prefecture sets.
 */
export const JP_FIRST_DIGIT_REGION: Record<string, string> = {
	"0": "Hokkaido & northern Tōhoku",
	"1": "Tokyo & Kanto",
	"2": "Kanagawa / Shizuoka & central",
	"3": "northern Kanto / Tōhoku",
	"4": "Tōkai / Chūbu",
	"5": "Kinki / Kansai",
	"6": "Kinki / Chūgoku west",
	"7": "Chūgoku / Shikoku",
	"8": "Kyūshū",
	"9": "Tōhoku north / other",
}

/**
 * The coarse region label for a postal code's first digit, or null if the input is not a Japanese
 * postal code. A weak, approximate prior (see {@link JP_FIRST_DIGIT_REGION}); the full code anchors
 * the address.
 */
export function firstDigitRegion(postalCode: unknown): string | null {
	const normalized = normalizeJpPostalCode(postalCode)
	if (!normalized) return null
	return JP_FIRST_DIGIT_REGION[normalized[0]!] ?? null
}
