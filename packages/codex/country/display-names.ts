/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Country surface forms across scripts, enumerated from the RUNTIME's own ICU via `Intl.DisplayNames`.
 *
 *   The gazetteer holds country names in English and little else, which is why a bare `格鲁吉亚` (Georgia the country,
 *   Chinese), `沙特阿拉伯` or `巴布亚新几内亚` resolves to nothing while `佐治亚州` (Georgia the US state) resolves
 *   correctly — the state is a real WOF record carrying multilingual names, and 140 of the 237 country rows are
 *   synthetic and carry only a canonical English name. Measured 2026-08-15; WOF has no Chinese country names at all,
 *   and `geonames-aliases.ts` filters every alias through a Latin-script regex.
 *
 *   ICU already knows all of it. No download, no vendored corpus, no licence question, and no drift against a snapshot
 *   we would otherwise have to refresh: the names come from the same ICU the runtime uses for every other
 *   locale-sensitive operation. Measured coverage at time of writing: **280 regions, 5,244 distinct surfaces** across
 *   the locale × style grid below.
 *
 *   This module ENUMERATES. It does not decide what the gazetteer stores — see the candidate build for that, and note
 *   that a surface here is a NAME THE WORLD USES, never an authority's designation.
 */

/**
 * The locales whose display names are enumerated. Chosen for script coverage rather than speaker count: each entry
 * either contributes a distinct script (Han simplified/traditional, Kana, Hangul, Arabic, Cyrillic, Devanagari, Hebrew,
 * Greek, Thai) or a major Latin-script exonym set that diverges from English.
 *
 * Adding a locale is additive and safe — surfaces are deduplicated — but every addition grows the candidate table, so
 * it earns its place by contributing surfaces a user would plausibly type.
 */
export const DISPLAY_NAME_LOCALES = [
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
] as const

/**
 * `long` is the ordinary name, `short` supplies the abbreviations people actually type (`UK`, `US`, `アメリカ`), and
 * `narrow` occasionally differs again. All three are enumerated because the query register is whatever the user wrote.
 */
export const DISPLAY_NAME_STYLES = ["long", "short", "narrow"] as const

/**
 * One country surface and where it came from.
 */
export interface CountryDisplayName {
	/**
	 * ISO 3166-1 alpha-2.
	 */
	iso2: string
	/**
	 * The surface as ICU renders it, unmodified — normalisation is the consumer's job, and the raw form is what a
	 * provenance record needs to be auditable.
	 */
	name: string
	/**
	 * BCP-47 tag this surface came from. Carried so a consumer can scope by locale rather than accepting every script for
	 * every query.
	 */
	locale: string
}

/**
 * Two-letter sequences that are not ISO 3166-1 regions. `Intl.DisplayNames.of` echoes its input for an unknown code, so
 * the echo IS the miss signal — no separate region list to keep in sync.
 */
/**
 * The AA–ZZ sweep bounds. ISO 3166-1 alpha-2 is exactly two uppercase ASCII letters, so enumerating the whole square
 * and keeping what ICU recognises avoids carrying a region list that would need its own upkeep.
 */
const ASCII_A = 65
const ASCII_Z = 90

function isEcho(code: string, rendered: string | undefined): boolean {
	return !rendered || rendered === code
}

/**
 * Enumerate every AA–ZZ code against the locale × style grid, keeping what ICU recognises.
 *
 * Deduplicated per (iso2, name): the same surface reached from several locales is one row, and the FIRST locale that
 * produced it wins the attribution — deterministic because {@link DISPLAY_NAME_LOCALES} is ordered.
 */
export function* enumerateCountryDisplayNames(
	locales: readonly string[] = DISPLAY_NAME_LOCALES
): Generator<CountryDisplayName> {
	const formatters = locales.flatMap((locale) =>
		DISPLAY_NAME_STYLES.map((style) => {
			try {
				return { locale, formatter: new Intl.DisplayNames([locale], { type: "region", style }) }
			} catch {
				// A runtime without this locale's data degrades to fewer surfaces, never to an error.
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
 * Every surface ICU knows for one country. Convenience over {@link enumerateCountryDisplayNames} for a single lookup;
 * the generator is the bulk path.
 */
export function countryDisplayNames(iso2: string, locales?: readonly string[]): string[] {
	const upper = iso2.toUpperCase()

	return [...enumerateCountryDisplayNames(locales)].filter((n) => n.iso2 === upper).map((n) => n.name)
}
