/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The four constituent countries of the United Kingdom, keyed by their ISO 3166-2:GB code: England
 *   (`ENG`), Scotland (`SCT`), Wales (`WLS`), Northern Ireland (`NIR`).
 *
 *   The UK's top-level admin tier is itself the first oddity of this system. France has régions,
 *   Germany has Bundesländer and the US has states as a single flat layer.
 *   The UK has constituent _countries_ within the country. An address rarely names its constituent
 *   country directly. It usually has a `street, town, postcode` shape. The postcode area provides a
 *   useful signal for inferring the constituent country, with documented exceptions in `postcode-area.ts`.
 *   This file provides the coarse admin label. The postcode area provides the geographic signal.
 */

import { foldName } from "#normalize"

/**
 * Per-country record: ISO 3166-2:GB code (sans `GB-` prefix) + English name.
 */
export interface UkCountryInfo {
	/**
	 * ISO 3166-2:GB country code without the `GB-` prefix (e.g. `ENG` for `GB-ENG`).
	 */
	code: string
	/**
	 * English name (e.g. `Scotland`).
	 */
	name: string
	/**
	 * The ONS GSS code for the country (e.g. `S92000003`).
	 * NSUL and other ONS products write it in `CTRY25CD`.
	 */
	gss: string
}

/**
 * ISO 3166-2:GB country code → info, for all four constituent countries.
 */
export const GB_COUNTRIES = {
	ENG: { code: "ENG", name: "England", gss: "E92000001" },
	SCT: { code: "SCT", name: "Scotland", gss: "S92000003" },
	WLS: { code: "WLS", name: "Wales", gss: "W92000004" },
	NIR: { code: "NIR", name: "Northern Ireland", gss: "N92000002" },
} as const satisfies Record<string, UkCountryInfo>

/**
 * An ISO 3166-2:GB constituent-country code (`ENG`, `SCT`, `WLS`, `NIR`).
 */
export type UkCountryCode = keyof typeof GB_COUNTRIES

const COUNTRY_CODE_SET: ReadonlySet<string> = new Set(Object.keys(GB_COUNTRIES))

const COUNTRY_BY_GSS: ReadonlyMap<string, UkCountryCode> = new Map(
	(Object.keys(GB_COUNTRIES) as UkCountryCode[]).map((code) => [GB_COUNTRIES[code].gss, code])
)

/**
 * The constituent country an ONS GSS country code identifies, such as `W92000004` → `WLS`.
 *
 * Returns null for any other code.
 */
export function ukCountryForGSS(gss: string): UkCountryCode | null {
	return COUNTRY_BY_GSS.get(gss.trim().toUpperCase()) ?? null
}

/**
 * Type-predicate for an ISO 3166-2:GB country code.
 *
 * Case-insensitive.
 */
export function isUkCountryCode(input: unknown): input is UkCountryCode {
	return typeof input === "string" && COUNTRY_CODE_SET.has(input.toUpperCase())
}

/**
 * Folded country name / code → ISO 3166-2:GB code, so a surface form maps regardless of casing.
 */
const COUNTRY_NAME_TO_CODE: ReadonlyMap<string, UkCountryCode> = (() => {
	const out = new Map<string, UkCountryCode>()

	for (const code of Object.keys(GB_COUNTRIES) as UkCountryCode[]) {
		out.set(foldName(GB_COUNTRIES[code].name), code)
		out.set(code.toLowerCase(), code)
	}

	return out
})()

/**
 * Resolve a UK constituent-country surface form (ISO code or English name) to its ISO code.
 * Null if unknown.
 *
 * Accepts `ENG`, `England`, `Northern Ireland`, `scotland`, etc.
 */
export function lookupUkCountry(input: string | null): UkCountryCode | null {
	if (!input || typeof input !== "string") return null
	const upper = input.trim().toUpperCase()

	if (COUNTRY_CODE_SET.has(upper)) return upper as UkCountryCode

	return COUNTRY_NAME_TO_CODE.get(foldName(input)) ?? null
}
