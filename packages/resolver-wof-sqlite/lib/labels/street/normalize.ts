// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { AbbreviationToDirectional, US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us"
import type { Tagged } from "type-fest"

/**
 * A place name folded by {@link normalizeLocalityForKey}, minted only by calling the fold.
 */
export type NameKey = Tagged<string, "NameKey">

/**
 * A street name folded by {@link normalizeStreetForKey} or {@link normalizeStreetForKeyLocale},
 * the form an address-point `street_norm` column stores.
 * Do not substitute {@link RouteKey} for this type.
 */
export type StreetKey = Tagged<string, "StreetKey">

/**
 * A street key that's also passed {@link canonicalizeRouteKey}; binding a plain {@link StreetKey}
 * to a route-folded column silently misses rows whose route spelling differs.
 */
export type RouteKey = Tagged<string, "RouteKey">

const MIN_TOKENS_FOR_TAIL_MERGE = 3

const SPELLED_ORDINAL_TO_DIGIT = new Map<string, string>([
	["first", "1st"],
	["second", "2nd"],
	["third", "3rd"],
	["fourth", "4th"],
	["fifth", "5th"],
	["sixth", "6th"],
	["seventh", "7th"],
	["eighth", "8th"],
	["ninth", "9th"],
	["tenth", "10th"],
	["eleventh", "11th"],
	["twelfth", "12th"],
	["thirteenth", "13th"],
	["fourteenth", "14th"],
	["fifteenth", "15th"],
	["sixteenth", "16th"],
	["seventeenth", "17th"],
	["eighteenth", "18th"],
	["nineteenth", "19th"],
	["twentieth", "20th"],
	["thirtieth", "30th"],
	["fortieth", "40th"],
	["fiftieth", "50th"],
	["sixtieth", "60th"],
	["seventieth", "70th"],
	["eightieth", "80th"],
	["ninetieth", "90th"],
	["hundredth", "100th"],
])

function fold(input: string): string {
	return input
		.normalize("NFKD")
		.replaceAll(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replaceAll(/[.,'’]/g, "")
		.replaceAll(/\s+/g, " ")
		.trim()
}

/**
 * The name and version of the street-key normalization {@link normalizeStreetForKeyLocale} applies.
 *
 * An artifact manifest of a street-keyed role records this pair with its locale,
 * and a reader refuses an artifact keyed by another version.
 * Version `1` is the normalization in this module when versions began to be recorded, on 2026-10-29.
 * A change to any key it produces is a new version.
 */
export const STREET_KEY_NORMALIZATION = { algorithm: "street-key", version: "1" } as const

/**
 * Normalizes a US or English street name into an address-point key, folding directionals,
 * spelled ordinals and the USPS street-type suffix.
 * The extract builder and the probe must both call it.
 */
export function normalizeStreetForKey(street: string): StreetKey {
	const tokens = fold(street).split(" ")

	if (!tokens.length) return "" as StreetKey

	for (let i = 0; i < tokens.length - 1; i++) {
		const digit = SPELLED_ORDINAL_TO_DIGIT.get(tokens[i]!)

		if (digit && US_STREET_SUFFIX_LOOKUP.has(tokens[i + 1]!)) {
			tokens[i] = digit
		}
	}

	const edgeDirectional = (raw: string) =>
		AbbreviationToDirectional.get(raw.toUpperCase())?.toLowerCase().replace(" ", "")

	const mergePair = (a?: string, b?: string) =>
		a && b && /^(north|south)$/.test(a) && /^(east|west)$/.test(b) ? a + b : null

	const leadPair = mergePair(tokens[0], tokens[1])

	if (leadPair && tokens.length > 2) {
		tokens.splice(0, 2, leadPair)
	}

	const first = edgeDirectional(tokens[0]!)

	if (first && tokens.length > 1) {
		tokens[0] = first
	}

	const tailPair = mergePair(tokens.at(-2), tokens.at(-1))

	if (tailPair && tokens.length > MIN_TOKENS_FOR_TAIL_MERGE) {
		tokens.splice(-2, 2, tailPair)
	}

	if (tokens.length > 2) {
		const last = edgeDirectional(tokens.at(-1)!)

		if (last) {
			tokens[tokens.length - 1] = last
		}
	}

	for (const at of [tokens.length - 1, tokens.length - 2]) {
		if (at < 1) continue
		const canonical = US_STREET_SUFFIX_LOOKUP.get(tokens[at]!)

		if (canonical) {
			tokens[at] = canonical.toLowerCase()

			break
		}
	}

	return tokens.join(" ") as StreetKey
}

/**
 * The name of one row of {@link STREET_KEY_RULES}, the rules a database's street,
 * locality and house-number keys are built under.
 *
 * Two functions produce one: `streetLocaleForCountry` in `#labels/street/locale`, for a country,
 * and {@link parseStreetLocale}, for a spelling an artifact manifest records or a command line passes.
 * A string literal is therefore refused where a street locale is expected,
 * and code reads a locale's behavior from its row with {@link streetKeyRulesOf}.
 */
export type StreetLocale = Tagged<string, "StreetLocale">

function foldHan(input: string): string {
	return input.normalize("NFKC").replaceAll("臺", "台").replaceAll(/\s+/g, "").toLowerCase()
}

const FR_STREET_ABBREV = new Map<string, string>([
	["av", "avenue"],
	["ave", "avenue"],
	["bd", "boulevard"],
	["bld", "boulevard"],
	["bvd", "boulevard"],
	["boul", "boulevard"],
	["pl", "place"],
	["imp", "impasse"],
	["all", "allee"],
	["ch", "chemin"],
	["che", "chemin"],
	["sq", "square"],
	["pas", "passage"],
	["fg", "faubourg"],
	["fbg", "faubourg"],
	["rte", "route"],
	["st", "saint"],
	["ste", "sainte"],
	["sts", "saints"],
])

const PL_LEADING_TYPE = new Set(["ul", "ulica", "al", "aleja", "aleje", "pl", "plac", "os", "osiedle"])

/**
 * Italian street types in the abbreviated spellings a person types, mapped to the spelling ANNCSU publishes.
 */
const IT_STREET_TYPE_ABBREV = new Map<string, string>([
	["v", "via"],
	["vle", "viale"],
	["vl", "viale"],
	["vic", "vicolo"],
	["vlo", "vicolo"],
	["str", "strada"],
	["pza", "piazza"],
	["pzza", "piazza"],
	["p", "piazza"],
	["ple", "piazzale"],
	["cso", "corso"],
	["c", "corso"],
	["lgo", "largo"],
	["loc", "localita"],
	["fraz", "frazione"],
	["cda", "contrada"],
	["lungarno", "lungarno"],
])

/**
 * Spanish street-type abbreviations whose expansion is the same token in every language
 * the register writes after `fold`; `c/`, `av`, and `pl` are deliberately absent
 * because they expand differently by region.
 */
const ES_STREET_TYPE_ABBREV = new Map<string, string>([
	["ctra", "carretera"],
	["crta", "carretera"],
	["rbla", "rambla"],
	["gta", "glorieta"],
	["cjon", "callejon"],
	["rda", "ronda"],
])

const ID_STREET_ABBREV = new Map<string, string>([
	["jl", "jalan"],
	["jln", "jalan"],
	["gg", "gang"],
])

const FRENCH_LEAD_TYPE =
	/^(?:rue|ruelle|av|ave|avenue|boul|bd|boulevard|ch|che|chemin|all[ée]e|imp|impasse|mont[ée]e|c[ôo]te|pl|place|prom|promenade|rang|rte|route|autoroute|carr[eé]|croissant|terrasse|sentier)(?=[\s.-]|$)/i

/**
 * The rules one street locale builds and probes keys under.
 *
 * A builder and a reader of one database read the same row, so they agree on every key.
 */
export interface StreetKeyRules {
	/**
	 * Builds the key a street name is stored and probed under.
	 */
	streetKey: (street: string) => StreetKey
	/**
	 * The streets keyed under another locale's rules: a street whose surface matches
	 * `pattern` is keyed under the row that `locale` spells.
	 *
	 * `null` keys every street under this row.
	 */
	surfaceRoute: { pattern: RegExp; locale: string } | null
	/**
	 * Whether a reader also probes the English respellings of a street: a doubled type word, a numbered
	 * street with and without its ordinal suffix, `Saint` for `St`, and a numbered route's designators.
	 */
	englishRespellings: boolean
	/**
	 * Builds the key a locality name is stored and probed under.
	 */
	localityKey: (locality: string) => NameKey
	/**
	 * Whether the stored locality keys are abbreviated or replaced by a parent place.
	 *
	 * A reader then lets a row's locality select a row and never reject one.
	 */
	localityKeys: "abbreviated" | "full"
	/**
	 * Whether a reader strips a trailing arrondissement designator from a query's locality key,
	 * because the builder keyed each arrondissement at its base city.
	 */
	arrondissementAtBaseCity: boolean
	/**
	 * Whether the stored locality key is the parse's `region` and `subregion` written together,
	 * for a register whose rows state neither postcode nor locality.
	 */
	localityFromRegionAndSubregion: boolean
	/**
	 * Builds the key a house number is stored and probed under.
	 */
	houseNumberKey: (number: string) => string
	/**
	 * Matches a house number written as a base number with joined sub-numbers, and captures the base.
	 * A reader probes the base after the written number misses.
	 *
	 * `null` when the locale writes no such number.
	 */
	houseNumberBase: RegExp | null
}

/**
 * The key of a street written in space-separated words: case folded, accents removed,
 * `ß` written `ss`, hyphens read as spaces, and the words then passed to `rewrite`.
 */
function wordStreetKey(street: string, rewrite?: (words: string[]) => void): StreetKey {
	const words = fold(street)
		.replaceAll("ß", "ss")
		.replaceAll("-", " ")
		.split(/\s+/)
		.filter((value) => value.length)

	if (!words.length) return "" as StreetKey

	rewrite?.(words)

	return words.join(" ") as StreetKey
}

/**
 * Replaces every word that `expansions` lists.
 */
function expandEveryWord(expansions: ReadonlyMap<string, string>): (words: string[]) => void {
	return (words) => {
		for (let i = 0; i < words.length; i++) {
			words[i] = expansions.get(words[i]!) ?? words[i]!
		}
	}
}

/**
 * Replaces the leading word that `expansions` lists, in a name of two or more words.
 *
 * The leading type is expanded and kept, because dropping it merges distinct streets
 * that share a name: `Calle Mayor` and `Plaza Mayor` can share a municipio.
 */
function expandLeadingWord(expansions: ReadonlyMap<string, string>): (words: string[]) => void {
	return (words) => {
		if (words.length > 1) {
			words[0] = expansions.get(words[0]!) ?? words[0]!
		}
	}
}

/**
 * Writes a word that ends in `str` with the full street word `full` in its place.
 */
function expandStreetSuffix(full: string): (words: string[]) => void {
	return (words) => {
		for (let i = 0; i < words.length; i++) {
			const word = words[i]!

			if (word.endsWith("str") && !word.endsWith(full)) {
				words[i] = word.replace(/str$/, full)
			}
		}
	}
}

/**
 * The rules every locale has unless its row states another.
 */
const SHARED_KEY_RULES: StreetKeyRules = {
	streetKey: (street) => wordStreetKey(street),
	surfaceRoute: null,
	englishRespellings: false,
	localityKey: normalizeLocalityForKey,
	localityKeys: "full",
	arrondissementAtBaseCity: false,
	localityFromRegionAndSubregion: false,
	houseNumberKey: (number) => number.trim().toLowerCase(),
	houseNumberBase: null,
}

/**
 * The rules of each street locale, keyed by the spelling an artifact manifest records.
 *
 * A spelling is therefore renamed only with its artifacts rebuilt.
 *
 * - `es`, `fr`, `de`, `it`, `nl`, `pl` and `id` are ISO 639-1 language codes.
 * - `vn` is Vietnamese, spelled with the country's code where the language's is `vi`.
 * - `zh` is Han script, and the one database under it is the Taiwanese register's.
 * - `en` and `us` build the same street key.
 *   `us` is the row of a database built without the surface route and with abbreviated
 *   locality keys, as the United States databases are.
 * - `und` has the shared rules only, for a country whose official languages select no one row.
 */
const STREET_KEY_RULES: Readonly<Record<string, StreetKeyRules>> = {
	us: { ...SHARED_KEY_RULES, streetKey: normalizeStreetForKey, englishRespellings: true, localityKeys: "abbreviated" },
	en: {
		...SHARED_KEY_RULES,
		streetKey: normalizeStreetForKey,
		// The route reads the surface and never the province, so a bilingual Canadian extract keys each street one way.
		surfaceRoute: { pattern: FRENCH_LEAD_TYPE, locale: "fr" },
		englishRespellings: true,
	},
	es: { ...SHARED_KEY_RULES, streetKey: (street) => wordStreetKey(street, expandLeadingWord(ES_STREET_TYPE_ABBREV)) },
	fr: {
		...SHARED_KEY_RULES,
		streetKey: (street) => wordStreetKey(street, expandEveryWord(FR_STREET_ABBREV)),
		arrondissementAtBaseCity: true,
	},
	de: { ...SHARED_KEY_RULES, streetKey: (street) => wordStreetKey(street, expandStreetSuffix("strasse")) },
	it: { ...SHARED_KEY_RULES, streetKey: (street) => wordStreetKey(street, expandLeadingWord(IT_STREET_TYPE_ABBREV)) },
	nl: { ...SHARED_KEY_RULES, streetKey: (street) => wordStreetKey(street, expandStreetSuffix("straat")) },
	pl: {
		...SHARED_KEY_RULES,
		streetKey: (street) =>
			wordStreetKey(street, (words) => {
				for (let i = 0; i < words.length; i++) {
					words[i] = words[i]!.replaceAll("ł", "l")
				}

				if (words.length > 1 && PL_LEADING_TYPE.has(words[0]!)) {
					words.shift()
				}
			}),
	},
	vn: {
		...SHARED_KEY_RULES,
		streetKey: (street) =>
			wordStreetKey(street, (words) => {
				for (let i = 0; i < words.length; i++) {
					words[i] = words[i]!.replaceAll("đ", "d").replaceAll("ð", "d")
				}
			}),
	},
	id: { ...SHARED_KEY_RULES, streetKey: (street) => wordStreetKey(street, expandEveryWord(ID_STREET_ABBREV)) },
	zh: {
		...SHARED_KEY_RULES,
		// A Han street name has no spaces and no type-word abbreviations.
		streetKey: (street) => foldHan(street) as StreetKey,
		localityKey: (locality) => foldHan(locality) as NameKey,
		localityFromRegionAndSubregion: true,
		// A Taiwanese house number ends in 號 and may be written in full-width digits.
		houseNumberKey: (number) =>
			foldHan(number)
				.replace(/^(\d+)號([之附]\d+)$/u, "$1$2")
				.replace(/號$/u, ""),
		// 之 and 附 join a sub-number to a base number, and the Taiwanese register stores the base.
		houseNumberBase: /^(\d+)(?:[之附]\d+)+$/u,
	},
	und: SHARED_KEY_RULES,
}

/**
 * The street locale a spelling names, for a spelling read from an artifact manifest or a command line.
 *
 * @throws For a spelling {@link STREET_KEY_RULES} has no row for.
 */
export function parseStreetLocale(spelling: string): StreetLocale {
	if (!Object.hasOwn(STREET_KEY_RULES, spelling)) {
		throw new Error(
			`"${spelling}" is no street locale. The street locales are ${Object.keys(STREET_KEY_RULES).join(", ")}.`
		)
	}

	return spelling as StreetLocale
}

/**
 * Every street locale, in the order {@link STREET_KEY_RULES} lists them.
 */
export const STREET_LOCALES: readonly StreetLocale[] = Object.keys(STREET_KEY_RULES).map(parseStreetLocale)

/**
 * The rules a street locale builds and probes keys under.
 */
export function streetKeyRulesOf(locale: StreetLocale): StreetKeyRules {
	return STREET_KEY_RULES[locale]!
}

/**
 * Builds a street name's address-point key under the given locale.
 * The extract builder and the probe must both call it.
 */
export function normalizeStreetForKeyLocale(street: string, locale: StreetLocale): StreetKey {
	return streetKeyRulesOf(locale).streetKey(street)
}

/**
 * Normalize a locality name for address-point keying, fold only with no street semantics.
 */
export function normalizeLocalityForKey(locality: string): NameKey {
	return fold(locality) as NameKey
}

/**
 * Apostrophe-like marks that romanized names contain and {@link normalizeLocalityForKey} keeps.
 *
 * The set holds the Hawaiian, Tongan and Uzbek ʻokina (U+02BB), the modifier
 * apostrophe (U+02BC), the reversed comma above (U+02BD), the prime (U+02B9),
 * the ʾalif and ʿayn half rings (U+02BE, U+02BF), and the left quotation mark (U+2018)
 * and backtick (U+0060) that romanized Arabic, Persian and Pashto names write for ʿayn.
 * A writer typing in ASCII leaves them out or types `'`, which the key drops.
 */
const APOSTROPHE_LIKE_MARKS = /[ʹʻ-ʿ‘`]/gu

/**
 * The key with every apostrophe-like mark removed, so `Hawaiʻi` and `` `Ajman ``
 * are also found as `hawaii` and `ajman`.
 *
 * The candidate build stages it as one more alias of the place.
 * The query-side key is unchanged, so a query written with the mark still matches the source spelling.
 */
export function withoutApostropheLikeMarks(key: NameKey): NameKey {
	return key.replaceAll(APOSTROPHE_LIKE_MARKS, "").replaceAll(/\s+/g, " ").trim() as NameKey
}

/**
 * The tatweel (U+0640), the short-vowel and shadda marks (U+064B–U+065F) and the superscript
 * alef (U+0670), with the hamza and madda that NFKD splits off `أ`, `إ`, `آ`, `ؤ` and `ئ`.
 */
const ARABIC_MARKS = /[ـً-ٰٟ]/gu

/**
 * The key with the Arabic letters that writers interchange folded together, so `الاسماعيليه`
 * and `الإسماعيلية`, or `الوادى الجديد` and `الوادي الجديد`, meet at one key.
 *
 * It removes {@link ARABIC_MARKS}, which leaves a hamza-carrying alef as a bare `ا`,
 * and writes `ى` (alef maqsura) as `ي` (yeh) and `ة` (taa marbuta) as `ه` (heh).
 * {@link normalizeLocalityForKey} doesn't apply it, so the columns keyed by that fold are unchanged.
 * A candidate build applies it to `name_key` only under the `arabic-letter-variants` key fold
 * (`#candidate/key-fold`), which the artifact records so its reader folds query keys too.
 */
export function withArabicLetterVariantsFolded(key: NameKey): NameKey {
	return key.normalize("NFKD").replaceAll(ARABIC_MARKS, "").replaceAll("ى", "ي").replaceAll("ة", "ه") as NameKey
}

/**
 * Builds a locality name's {@link NameKey} under the given locale.
 *
 * The Han rule is a row's own, so the columns of every other locale keep their keys.
 */
export function normalizeLocalityForKeyLocale(locality: string, locale: StreetLocale): NameKey {
	return streetKeyRulesOf(locale).localityKey(locality)
}

/**
 * Builds a house number's address-point key under the given locale.
 */
export function normalizeHouseNumberForKey(number: string, locale: StreetLocale): string {
	return streetKeyRulesOf(locale).houseNumberKey(number)
}

/**
 * The locale a street's key is built under: the one `base`'s surface route sends the street to,
 * or `base` when the row has no route or the street doesn't match it.
 */
export function streetLocaleForSurface(street: string, base: StreetLocale): StreetLocale {
	const route = streetKeyRulesOf(base).surfaceRoute

	return route?.pattern.test(street.trimStart()) ? parseStreetLocale(route.locale) : base
}

/**
 * Strips a trailing French arrondissement designator from a folded commune key,
 * returning the input unchanged when the strip would leave no text.
 */
export function stripArrondissement(localityNorm: NameKey): NameKey {
	const stripped = localityNorm.replace(/\s+\d+(?:er|e)\s+arrondissement$/, "").trim() as NameKey

	return stripped || localityNorm
}

/**
 * Strips a disambiguating qualifier from a locality name for a query-side retry,
 * returning an empty string when no text was stripped.
 *
 * The result must be refolded with {@link normalizeLocalityForKey} before probing.
 */
export function stripLocalityQualifier(locality: string): string {
	let s = locality.trim()

	if (s.includes("/")) {
		s = s.split("/")[0]!.trim()
	}

	const words = [...s.matchAll(/\S+/gu)].map((match) => ({ value: match[0], index: match.index }))
	let qualifierStart: number | null = null

	for (let index = 1; index < words.length; index++) {
		const word = words[index]!
		const first = word.value[0] ?? ""
		const abbreviated = /[a-zà-ÿ]/iu.test(first) && word.value[1] === "." && word.value.length > 2
		const oneWordQualifier = ["im", "ob", "bei", "unter", "vor"].includes(word.value.toLowerCase())

		const twoWordQualifier =
			["an", "in"].includes(word.value.toLowerCase()) && words[index + 1]?.value.toLowerCase() === "der"

		const hasQualifierValue = oneWordQualifier ? index + 1 < words.length : index + 2 < words.length

		if (abbreviated || ((oneWordQualifier || twoWordQualifier) && hasQualifierValue)) {
			qualifierStart = word.index

			break
		}
	}

	const suffix = words.at(-1)

	if (
		qualifierStart === null &&
		suffix &&
		words.length > 1 &&
		(["S", "N", "E", "W", "V", "Ø", "Sø", "Fyn", "Thy", "Sjælland", "Jylland"].includes(suffix.value) ||
			/^[A-ZÅÄÖ]{2}$/u.test(suffix.value))
	) {
		qualifierStart = suffix.index
	}

	if (qualifierStart !== null) {
		s = s.slice(0, qualifierStart).trimEnd()
	}

	s = s.trim()

	return s === locality.trim() ? "" : s
}

/**
 * Folds a numbered-route designator in a street key to `us route N` or `state route N`;
 * only digit-leading numbers after a `us`, `state`, or two-letter prefix fold.
 */
export function canonicalizeRouteKey(streetNorm: StreetKey): RouteKey {
	const match = /^(us|state|[a-z]{2}) (?:route|rte|rt|highway|hwy) (\d.*)$/.exec(streetNorm)

	if (!match) return streetNorm as string as RouteKey

	return `${match[1] === "us" ? "us" : "state"} route ${match[2]}` as RouteKey
}

const CANONICAL_TYPE_WORDS: ReadonlySet<string> = new Set(
	[...US_STREET_SUFFIX_LOOKUP.values()].map((v) => v.toLowerCase())
)

const ENGLISH_ORDINAL_RULES = new Intl.PluralRules("en-US", { type: "ordinal" })

const ENGLISH_ORDINAL_SUFFIX: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" }

function ordinalOf(n: number): string {
	return `${n}${ENGLISH_ORDINAL_SUFFIX[ENGLISH_ORDINAL_RULES.select(n)] ?? "th"}`
}

/**
 * Lists the lookup keys to probe for a street span, most literal first, adding the
 * English respellings for a locale whose rules probe them.
 */
export function streetKeyVariants(street: string, locale: StreetLocale): StreetKey[] {
	const rules = streetKeyRulesOf(locale)
	const primary = rules.streetKey(street)
	const variants: StreetKey[] = primary ? [primary] : []

	if (!primary || !rules.englishRespellings) return variants

	const tokens = primary.split(" ")
	const last = tokens.at(-1)
	const secondLast = tokens.at(-2)

	if (
		tokens.length > 2 &&
		last &&
		secondLast &&
		CANONICAL_TYPE_WORDS.has(last) &&
		!CANONICAL_TYPE_WORDS.has(secondLast) &&
		US_STREET_SUFFIX_LOOKUP.has(secondLast)
	) {
		const collapsed = normalizeStreetForKey(tokens.slice(0, -1).join(" "))

		if (collapsed && !variants.includes(collapsed)) {
			variants.push(collapsed)
		}
	}

	// NAD writes a numbered street with its ordinal suffix ("48th St")
	// and NYC Open Data writes the bare number ("48 ST").
	// The build keys each row as written, so the reader probes both forms.
	for (const variant of variants.slice()) {
		const parts = variant.split(" ")

		const toggled = parts
			.map((token, i) => {
				// Only a number followed by a street type is an ordinal ("48 street"), not "us route 9".
				if (!CANONICAL_TYPE_WORDS.has(parts[i + 1] ?? "")) return token
				const bare = /^(\d+)(?:st|nd|rd|th)$/.exec(token)?.[1]

				if (bare) return bare

				return /^\d+$/.test(token) ? ordinalOf(Number(token)) : token
			})
			.join(" ") as StreetKey

		if (toggled !== variant && !variants.includes(toggled)) {
			variants.push(toggled)
		}
	}

	const preSwap = variants.slice()

	for (const variant of preSwap) {
		const [head, ...rest] = variant.split(" ")
		const swapped = head === "saint" ? "st" : head === "st" ? "saint" : null

		if (swapped && rest.length) {
			const candidate = [swapped, ...rest].join(" ") as StreetKey

			if (!variants.includes(candidate)) {
				variants.push(candidate)
			}
		}
	}

	for (const candidate of routeKeyVariants(primary)) {
		if (!variants.includes(candidate)) {
			variants.push(candidate)
		}
	}

	return variants
}

/**
 * The route designators a numbered road is written with, by the system the query's prefix selects.
 *
 * The forms are the ones US address sources store, measured over the state extracts:
 * `state road 10`, `state highway 42`, `highway 79`, `united states highway 31`, `interstate 35`.
 */
const ROUTE_DESIGNATORS: Readonly<Record<"us" | "state" | "interstate", readonly string[]>> = {
	us: ["united states highway", "us highway", "us route", "highway", "route"],
	state: ["state road", "state highway", "state route", "highway", "route"],
	interstate: ["interstate"],
}

/**
 * The spellings of a county road, as US address sources store them.
 *
 * Wisconsin leads with `cth`, Texas with `county road`, and Florida with `cr`,
 * and a county road may take letters, as `cth cw` does.
 */
const COUNTY_ROAD_DESIGNATORS: readonly string[] = ["county road", "county highway", "county", "cth", "co road", "cr"]

/**
 * Reads a county road's designator from a query, such as `county rd cw`,
 * `cty hwy 5`, `co rd 12`, `cr 40` or `cth a`.
 *
 * A bare `co 5` stays a Colorado state route.
 */
const COUNTY_ROAD_QUERY =
	/^(?:(?:county|cty|co) (?:road|rd|highway|hwy|trunk|trunk highway) (\d+[a-z]?|[a-z]{1,3})|(?:county|cty|cth|cr) (\d+[a-z]?|[a-z]{1,2}))$/

const COMPASS_WORDS: readonly string[] = ["north", "south", "east", "west"]

/**
 * A query's route number and system: `in 245` and `state route 245` read as state routes,
 * `us 93` as a US route, and `i 68` as an interstate.
 *
 * A two-letter prefix is any state's code, because the shape is the same in every state.
 */
function parseRouteQuery(key: string): { system: keyof typeof ROUTE_DESIGNATORS; route: string } | null {
	const match =
		/^(us|i|interstate|[a-z]{2}|state|sr)(?: (?:road|rd|route|rte|rt|highway|hwy))? (\d+[a-z]?)$/.exec(key) ??
		/^(highway|hwy|route|rte)() ?(\d+[a-z]?)$/.exec(key)

	if (!match) return null

	const route = match.at(-1)!
	const prefix = match[1]!

	if (prefix === "us") return { system: "us", route }

	if (prefix === "i" || prefix === "interstate") return { system: "interstate", route }

	return { system: "state", route }
}

/**
 * Lists the stored spellings of a numbered route, with and without the compass word a source may add.
 *
 * `IN-245` is stored as `north state road 245` in Indiana, so a query gives no hint of the spelling.
 * The caller's postcode, locality or box still scopes each probe.
 */
export function routeKeyVariants(key: StreetKey): StreetKey[] {
	const written = key.replaceAll("-", " ")
	const countyRoad = COUNTY_ROAD_QUERY.exec(written)

	if (countyRoad) {
		const route = countyRoad[1] ?? countyRoad[2]!

		return COUNTY_ROAD_DESIGNATORS.map((designator) => `${designator} ${route}` as StreetKey)
	}

	const parsed = parseRouteQuery(written)

	if (!parsed) return []

	return ROUTE_DESIGNATORS[parsed.system].flatMap((designator) => {
		const base = `${designator} ${parsed.route}`

		return [
			base,
			...COMPASS_WORDS.map((compass) => `${compass} ${base}`),
			...COMPASS_WORDS.map((compass) => `${base} ${compass}`),
		] as StreetKey[]
	})
}
