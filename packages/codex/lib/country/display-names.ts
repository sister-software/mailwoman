/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Enumerate multilingual country-name surfaces from the runtime's ICU data with `Intl.DisplayNames`.
 *   This module supplies candidate names; the gazetteer build decides which names to store. A surface is not an
 *   official designation.
 */

/**
 * Locales selected for script coverage and distinct Latin-script exonyms.
 */
export const DISPLAY_NAME_LOCALES: readonly Intl.UnicodeBCP47LocaleIdentifier[] = [
	"en",
	"zh-Hans",
	"zh-Hant",
	"ja",
	"ko",
	"ar",
	"ru",
	"es",
	"fr",
	"de",
	"hi",
	"pt",
	"it",
	"nl",
	"pl",
	"tr",
	"vi",
	"th",
	"id",
	"fa",
	"he",
	"uk",
	"sv",
	"el",
]

/**
 * Enumerate all ICU styles because users may enter full, abbreviated, or narrow forms.
 */
export const DISPLAY_NAME_STYLES = ["long", "short", "narrow"] as const

/**
 * Country-name surface and its ICU locale provenance.
 */
export interface CountryDisplayName {
	/**
	 * ISO 3166-1 alpha-2 code.
	 */
	iso2: string
	/**
	 * Raw ICU surface; consumers handle normalization.
	 */
	name: string
	/**
	 * BCP-47 locale that produced this surface.
	 */
	locale: string
}

/**
 * Bounds for the AA–ZZ sweep.
 *
 * ICU echoes unknown codes, so no separate region list is needed.
 */
const ASCII_A = 65
const ASCII_Z = 90

function isEcho(code: string, rendered: string | undefined): boolean {
	return !rendered || rendered === code
}

/**
 * Enumerate recognized AA–ZZ country codes and deduplicate surfaces,
 * preserving the first locale that produces each.
 */
export function* enumerateCountryDisplayNames(
	locales: readonly string[] = DISPLAY_NAME_LOCALES
): Generator<CountryDisplayName> {
	const formatters = locales.flatMap((locale) =>
		DISPLAY_NAME_STYLES.map((style) => {
			try {
				return { locale, formatter: new Intl.DisplayNames([locale], { type: "region", style }) }
			} catch {
				// Skip unsupported locales and retain surfaces from the remaining locales.
				return undefined
			}
		}).filter((f) => f !== null && f !== undefined)
	)

	for (let a = ASCII_A; a <= ASCII_Z; a++) {
		for (let b = ASCII_A; b <= ASCII_Z; b++) {
			const iso2 = String.fromCharCode(a, b)
			const seen = new Set<string>()

			for (const { locale, formatter } of formatters) {
				let rendered: string | undefined

				try {
					rendered = formatter.of(iso2)
				} catch {
					continue
				}

				if (isEcho(iso2, rendered) || seen.has(rendered!)) continue
				seen.add(rendered!)

				yield { iso2, name: rendered!, locale }
			}
		}
	}
}

/**
 * Return all enumerated surfaces for one country.
 */
export function countryDisplayNames(iso2: string, locales?: readonly string[]): string[] {
	const upper = iso2.toUpperCase()

	return [...enumerateCountryDisplayNames(locales)].filter((n) => n.iso2 === upper).map((n) => n.name)
}
