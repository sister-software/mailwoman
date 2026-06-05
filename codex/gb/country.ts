/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The four constituent countries of the United Kingdom, keyed by their ISO 3166-2:GB code: England
 *   (`ENG`), Scotland (`SCT`), Wales (`WLS`), Northern Ireland (`NIR`).
 *
 *   The UK's top-level admin tier is itself the first oddity of this system. France has régions,
 *   Germany has Bundesländer, the US has states — a single flat layer. The UK has _countries_
 *   inside a country, and an address almost never names which one: a line reads `street, town,
 *   postcode`, and the constituent country is inferred — usually, but not always cleanly, from the
 *   postcode area (see `postcode-area.ts`). So this file is the coarse admin label, and the
 *   postcode is the thing that actually carries the geography.
 */

/** Per-country record: ISO 3166-2:GB code (sans `GB-` prefix) + English name. */
export interface UkCountryInfo {
	/** ISO 3166-2:GB country code without the `GB-` prefix (e.g. `ENG` for `GB-ENG`). */
	code: string
	/** English name (e.g. `Scotland`). */
	name: string
}

/** ISO 3166-2:GB country code → info, for all four constituent countries. */
export const GB_COUNTRIES = {
	ENG: { code: "ENG", name: "England" },
	SCT: { code: "SCT", name: "Scotland" },
	WLS: { code: "WLS", name: "Wales" },
	NIR: { code: "NIR", name: "Northern Ireland" },
} as const satisfies Record<string, UkCountryInfo>

/** An ISO 3166-2:GB constituent-country code (`ENG`, `SCT`, `WLS`, `NIR`). */
export type UkCountryCode = keyof typeof GB_COUNTRIES

const COUNTRY_CODE_SET: ReadonlySet<string> = new Set(Object.keys(GB_COUNTRIES))

/** Type-predicate for an ISO 3166-2:GB country code. Case-insensitive. */
export function isUkCountryCode(input: unknown): input is UkCountryCode {
	return typeof input === "string" && COUNTRY_CODE_SET.has(input.toUpperCase())
}

/** Lowercase + collapse non-alphanumerics so `Northern Ireland`, `northern-ireland` key alike. */
function foldName(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
}

/** Folded country name / code → ISO 3166-2:GB code, so a surface form maps regardless of casing. */
const COUNTRY_NAME_TO_CODE: ReadonlyMap<string, UkCountryCode> = (() => {
	const out = new Map<string, UkCountryCode>()
	for (const code of Object.keys(GB_COUNTRIES) as UkCountryCode[]) {
		out.set(foldName(GB_COUNTRIES[code].name), code)
		out.set(code.toLowerCase(), code)
	}
	return out
})()

/**
 * Resolve a UK constituent-country surface form (ISO code or English name) to its ISO code; null if
 * unknown. Accepts `ENG`, `England`, `Northern Ireland`, `scotland`, etc.
 */
export function lookupUkCountry(input: string | null | undefined): UkCountryCode | null {
	if (!input || typeof input !== "string") return null
	const upper = input.trim().toUpperCase()
	if (COUNTRY_CODE_SET.has(upper)) return upper as UkCountryCode
	return COUNTRY_NAME_TO_CODE.get(foldName(input)) ?? null
}
