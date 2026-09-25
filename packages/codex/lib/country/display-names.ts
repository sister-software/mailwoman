/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lists country names in many languages from the runtime's ICU data through `Intl.DisplayNames`. The gazetteer
 *   build decides which of these candidate names to store.
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
 * The ICU display styles to list.
 * Users type full, abbreviated and narrow forms.
 */
export const DISPLAY_NAME_STYLES = ["long", "short", "narrow"] as const

/**
 * A country name and the ICU locale that produced it.
 */
export interface CountryDisplayName {
	/**
	 * The ISO 3166-1 alpha-2 code.
	 */
	iso2: string
	/**
	 * The name exactly as ICU returns it.
	 * Consumers normalize it.
	 */
	name: string
	/**
	 * The BCP-47 locale that produced this name.
	 */
	locale: string
}

/**
 * Character codes for the AA to ZZ sweep.
 *
 * ICU returns an unknown code unchanged, so the sweep needs no separate region list.
 */
const ASCII_A = 65
const ASCII_Z = 90

/**
 * Returns whether ICU echoed the code back, which means it does not know the region.
 */
function isEcho(code: string, rendered: string | undefined): boolean {
	return !rendered || rendered === code
}

/**
 * Yields each distinct name for every code from AA to ZZ that ICU recognizes.
 *
 * Each name is attributed to the first locale that produced it.
 */
export function* enumerateCountryDisplayNames(
	locales: readonly string[] = DISPLAY_NAME_LOCALES
): Generator<CountryDisplayName> {
	const formatters = locales.flatMap((locale) =>
		DISPLAY_NAME_STYLES.map((style) => {
			try {
				return { locale, formatter: new Intl.DisplayNames([locale], { type: "region", style }) }
			} catch {
				// The runtime does not support this locale.
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
 * Returns every listed name for one country.
 */
export function countryDisplayNames(iso2: string, locales?: readonly string[]): string[] {
	const upper = iso2.toUpperCase()

	return [...enumerateCountryDisplayNames(locales)].filter((n) => n.iso2 === upper).map((n) => n.name)
}
