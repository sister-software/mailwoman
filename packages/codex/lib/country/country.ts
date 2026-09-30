/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Country matching utilities for address parsing.
 *
 * Uses ISO 3166-1 names/codes from {@link ./names.ts} and {@link ./codes.ts},
 * then adds common address spellings (endonyms and abbreviations).
 *
 * Includes {@link matchCountry}, in the same style as other codex matchers.
 */

import { Alpha3ToCountryRecord, CountryISO2 } from "#country/codes"
import type { CountryName } from "#country/names"
import { foldName } from "#normalize"

export { Alpha3ToCountryRecord, CountryISO2, type CountryISO3 } from "#country/codes"

/**
 * Common address spellings by ISO alpha-2.
 *
 * First item is the preferred display form.
 * The matcher ignores case.
 *
 * This is a curated subset.
 * ISO names and codes still cover all countries.
 */
export const COUNTRY_SURFACE_FORMS = {
	US: ["United States", "USA", "US", "U.S.A.", "U.S.", "United States of America", "America"],
	DE: ["Germany", "Deutschland", "DE", "GER", "Federal Republic of Germany"],
	FR: ["France", "FR", "FRA", "French Republic"],
	GB: ["United Kingdom", "UK", "Great Britain", "Britain", "England", "GB", "U.K."],
	ES: ["Spain", "España", "Espana", "ES", "ESP"],
	IT: ["Italy", "Italia", "IT", "ITA"],
	NL: ["Netherlands", "Nederland", "The Netherlands", "Holland", "NL", "NLD"],
	CA: ["Canada", "CA", "CAN"],
	AU: ["Australia", "AU", "AUS"],
	NZ: ["New Zealand", "NZ", "Aotearoa"],
	CH: ["Switzerland", "Schweiz", "Suisse", "Svizzera", "CH"],
	AT: ["Austria", "Österreich", "Osterreich", "AT"],
	BE: ["Belgium", "België", "Belgique", "BE"],
	IE: ["Ireland", "Éire", "IE", "IRL"],
	MX: ["Mexico", "México", "MX", "MEX"],
	BR: ["Brazil", "Brasil", "BR", "BRA"],
	JP: ["Japan", "日本", "Nippon", "JP", "JPN"],
	// `ROM` was Romania's alpha-3 until ISO replaced it with `ROU` in 2002.
	// The ISO table carries `ROU`, and the retired code stays resolvable here
	// because address data outlives a standard's revisions.
	RO: ["Romania", "RO", "ROU", "ROM"],
} as const satisfies Partial<Record<CountryISO2, readonly string[]>>

export type CountrySurfaceISO2 = keyof typeof COUNTRY_SURFACE_FORMS

/**
 * Alpha-2 -> canonical English country name.
 */
export const ISO2_TO_NAME: ReadonlyMap<string, CountryName> = new Map(
	Object.entries(CountryISO2).map(([name, code]) => [code as string, name as CountryName])
)

/**
 * Maps known country text (name/form/alpha-2/alpha-3) to alpha-2.
 *
 * Built once at module load.
 * Stores lowercase keys and {@link foldName}-folded keys, so accents/punctuation still match.
 *
 * Includes ISO names/codes plus curated surface forms.
 * On collisions, curated surface forms win.
 */
export const COUNTRY_LOOKUP: ReadonlyMap<string, string> = (() => {
	const out = new Map<string, string>()

	const put = (k: string, iso2: string) => {
		const key = k.trim().toLowerCase()

		if (key && !out.has(key)) {
			out.set(key, iso2)
		}

		const folded = foldName(k)

		if (folded && !out.has(folded)) {
			out.set(folded, iso2)
		}
	}

	// ISO base: canonical name + alpha-2 + alpha-3.
	for (const [name, code] of Object.entries(CountryISO2)) {
		put(name, code as string)
	}

	for (const [code] of Object.entries(CountryISO2)) {
		put(code, code as string)
	}

	// Alpha-3 to alpha-2, e.g. "USA" -> "US".
	for (const [alpha3, name] of Object.entries(Alpha3ToCountryRecord)) {
		const iso2 = CountryISO2[name as keyof typeof CountryISO2]

		if (iso2) {
			put(alpha3, iso2)
		}
	}

	// Curated surface forms override ISO entries on collision.
	for (const [iso2, forms] of Object.entries(COUNTRY_SURFACE_FORMS)) {
		for (const f of forms) {
			out.set(f.trim().toLowerCase(), iso2)

			const folded = foldName(f)

			if (folded) {
				out.set(folded, iso2)
			}
		}
	}

	return out
})()

/**
 * Check lookup by lowercase token first, then by folded token.
 */
function probeCountry(token: string): string | undefined {
	const direct = COUNTRY_LOOKUP.get(token.trim().toLowerCase())

	if (direct) return direct

	const folded = foldName(token)

	return folded ? COUNTRY_LOOKUP.get(folded) : undefined
}

/**
 * Result of a country match.
 *
 * Contains the alpha-2 code and canonical name.
 * It also records the matched input.
 */
export interface CountryMatch {
	iso2: string
	canonical: CountryName | undefined
	matched: string
}

/**
 * Resolve a token (surface form, name, alpha-2, or alpha-3) to a country.
 *
 * Case-, accent-, and punctuation-insensitive.
 * Returns null if unrecognized.
 *
 * Multi-word names must be passed as full phrases.
 */
export function matchCountry(token: string | null | undefined): CountryMatch | null {
	if (!token || typeof token !== "string") return null
	const iso2 = probeCountry(token)

	if (!iso2) return null

	return { iso2, canonical: ISO2_TO_NAME.get(iso2), matched: token.trim() }
}

/**
 * Get a table key (ISO alpha-2) from a country field value.
 *
 * If value is 2 letters, treat it as a code directly.
 * This differs from {@link matchCountry}, which is stricter for free-form address text.
 *
 * Longer values are resolved through {@link matchCountry}.
 *
 * Returns undefined if unresolved.
 */
export function countryCodeForTable(country: string | null | undefined): string | undefined {
	const trimmed = country?.trim()

	if (!trimmed) return undefined

	if (trimmed.length === 2) return trimmed.toUpperCase()

	return matchCountry(trimmed)?.iso2
}

/**
 * Normalize and validate an ISO 3166-1 alpha-2 code.
 *
 * Use this when input is expected to be a real country code.
 * For free-form country text, use {@link matchCountry}.
 */
export function formatAsCountryISO2(value: string): CountryISO2 {
	const code = value.trim().toUpperCase()

	if (!Object.values(CountryISO2).includes(code as CountryISO2)) {
		throw new TypeError(`expected an ISO 3166-1 alpha-2 country code, got ${value}`)
	}

	return code as CountryISO2
}

/**
 * Check whether value has the two-uppercase-letter country-code shape.
 *
 * This allows non-ISO values that still use that shape.
 *
 * Examples: `XK` (Kosovo in some systems), `ZZ` (unknown country placeholder).
 *
 * Use {@link formatAsCountryISO2} when ISO membership is required.
 */
export function isAlpha2CodeShape(value: unknown): value is string {
	return typeof value === "string" && /^[A-Z]{2}$/u.test(value)
}

/**
 * Case-insensitive check for any recognized country form.
 */
export function isCountryToken(token: unknown): boolean {
	return typeof token === "string" && probeCountry(token) !== undefined
}

/**
 * Preferred display forms for an alpha-2 code (canonical first).
 *
 * Returns empty array if none are curated.
 */
export function countrySurfaceForms(iso2: string): readonly string[] {
	return (COUNTRY_SURFACE_FORMS as Record<string, readonly string[]>)[iso2.toUpperCase()] ?? []
}
