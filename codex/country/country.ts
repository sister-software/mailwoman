/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Country recognition for the `country` parity lever. The ISO 3166-1 base (names + alpha-2/alpha-3)
 *   is salvaged from isp-nexus `spatial/countries` ({@link ./names.ts}, {@link ./codes.ts}); this
 *   adds the layer ISO doesn't carry — the **surface forms** addresses actually use (endonyms +
 *   common abbreviations: "USA"/"United States"/"U.S."; "Deutschland"/"Germany"; "España"/"Spain")
 *   — plus a {@link matchCountry} resolver the corpus country-shard + parsing reuse. Same shape as
 *   the other codex matchers (street-suffix, directional, po-box).
 */

import { Alpha3ToCountryRecord, CountryISO2, type CountryISO3 } from "./codes.js"
import { type CountryName } from "./names.js"

/**
 * Common real-address surface forms per ISO 3166-1 alpha-2, **canonical English name first** then endonym +
 * abbreviations. Curated for the corpus locales + frequent countries (NOT a full 249-entry variant table — the ISO base
 * below catches the canonical name/code for everything else). Forms are matched case-insensitively; the first entry is
 * the preferred render form.
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
	CH: ["Switzerland", "Schweiz", "Suisse", "Svizzera", "CH"],
	AT: ["Austria", "Österreich", "Osterreich", "AT"],
	BE: ["Belgium", "België", "Belgique", "BE"],
	IE: ["Ireland", "Éire", "IE", "IRL"],
	MX: ["Mexico", "México", "MX", "MEX"],
	JP: ["Japan", "日本", "Nippon", "JP", "JPN"],
} as const satisfies Partial<Record<string, readonly string[]>>

export type CountrySurfaceIso2 = keyof typeof COUNTRY_SURFACE_FORMS

/** Alpha-2 → canonical English name (inverted from the salvaged CountryISO2 enum). */
export const ISO2_TO_NAME: ReadonlyMap<string, CountryName> = new Map(
	Object.entries(CountryISO2).map(([name, code]) => [code as string, name as CountryName])
)

/**
 * Any recognized country surface form / canonical name / alpha-2 / alpha-3 → alpha-2 code. Built once at module load,
 * lowercase-keyed. Canonical names + codes from the ISO base, plus the curated surface forms (surface forms win on
 * collision — they're the address-facing spellings).
 */
export const COUNTRY_LOOKUP: ReadonlyMap<string, string> = (() => {
	const out = new Map<string, string>()
	const put = (k: string, iso2: string) => {
		const key = k.trim().toLowerCase()

		if (key && !out.has(key)) out.set(key, iso2)
	}

	// ISO base: canonical name + alpha-2 + alpha-3.
	for (const [name, code] of Object.entries(CountryISO2)) {
		put(name, code as string)
	}

	for (const [code] of Object.entries(CountryISO2)) {
		put(code, code as string)
	}

	// "US" -> US
	for (const [alpha3, name] of Object.entries(Alpha3ToCountryRecord)) {
		const iso2 = CountryISO2[name as keyof typeof CountryISO2]

		if (iso2) put(alpha3, iso2) // "USA" -> US, "DEU" -> DE
	}

	// Curated surface forms (override — address spellings beat the ISO base on collision).
	for (const [iso2, forms] of Object.entries(COUNTRY_SURFACE_FORMS)) {
		for (const f of forms) out.set(f.trim().toLowerCase(), iso2)
	}

	return out
})()

/** Result of a country match: the alpha-2 code, the canonical English name, and the matched surface. */
export interface CountryMatch {
	iso2: string
	canonical: CountryName | undefined
	matched: string
}

/**
 * Resolve a token (surface form, canonical name, alpha-2, or alpha-3) to a country. Case-insensitive. Returns null if
 * unrecognized. Multi-word names ("United States", "Great Britain") must be passed as the whole phrase — the caller
 * decides the span; this matches it.
 */
export function matchCountry(token: string | null | undefined): CountryMatch | null {
	if (!token || typeof token !== "string") return null
	const iso2 = COUNTRY_LOOKUP.get(token.trim().toLowerCase())

	if (!iso2) return null

	return { iso2, canonical: ISO2_TO_NAME.get(iso2), matched: token.trim() }
}

/** Case-insensitive check: is the token any recognized country form? */
export function isCountryToken(token: unknown): boolean {
	return typeof token === "string" && COUNTRY_LOOKUP.has(token.trim().toLowerCase())
}

/**
 * The preferred render forms for an alpha-2 (canonical first), for synth shards. Empty if none curated.
 */
export function countrySurfaceForms(iso2: string): readonly string[] {
	return (COUNTRY_SURFACE_FORMS as Record<string, readonly string[]>)[iso2.toUpperCase()] ?? []
}

export { Alpha3ToCountryRecord, CountryISO2 }
export type { CountryISO3, CountryName }
