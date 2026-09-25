/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AbbreviationToDirectional, US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us"
import type { Tagged } from "type-fest"

/**
 * Represents a place name folded by {@link normalizeLocalityForKey},
 * the form every `name_key`-style column stores.
 *
 * The brand exists because a near-miss fold such as `toLowerCase()` still binds
 * and silently returns fewer rows, so mint one only by calling the fold.
 */
export type NameKey = Tagged<string, "NameKey">

/**
 * Represents a street name folded by {@link normalizeStreetForKey} or
 * {@link normalizeStreetForKeyLocale}, the form an address-point `street_norm` column stores.
 *
 * It is not interchangeable with {@link RouteKey}, which some columns apply on top and others do not.
 */
export type StreetKey = Tagged<string, "StreetKey">

/**
 * Represents a street key that has also passed {@link canonicalizeRouteKey}.
 *
 * Binding a plain {@link StreetKey} to a route-folded column silently misses
 * every row whose route spelling differs.
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
 * Normalizes a US or English street name into an address-point key, folding directionals,
 * spelled ordinals and the USPS street-type suffix.
 *
 * The extract builder and the probe must both call this function, because the
 * key only has to agree with itself.
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
		a && b && /^(north|south)$/.test(a) && /^(east|west)$/.test(b) ? a + b : undefined

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
 * Names the rule set {@link normalizeStreetForKeyLocale} uses to fold a street
 * name into an address-point key.
 */
export type StreetLocale = "us" | "en" | "fr" | "de" | "it" | "nl" | "pl" | "vn" | "id" | "zh"

function foldHan(input: string): string {
	return input.normalize("NFKC").replaceAll("臺", "台").replaceAll(/\s+/g, "").toLowerCase()
}

/**
 * Creates a country-to-street-locale lookup for an acquisition SDK, appending `label`
 * to the error it throws for an unregistered country.
 *
 * It throws rather than falling back, because an extract built with the wrong locale
 * keys every street wrongly and fails only at probe time.
 */
export function createStreetLocaleRegistry(
	registry: ReadonlyMap<string, StreetLocale>,
	label: string
): { localeFor: (countryCode: string) => StreetLocale; supported: () => string[] } {
	return {
		localeFor: (countryCode) => {
			const locale = registry.get(countryCode.toLowerCase())

			if (!locale) {
				throw new Error(`No street-normalization locale registered for country "${countryCode}". ${label}`)
			}

			return locale
		},
		supported: () => [...registry.keys()],
	}
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
 *
 * ANNCSU writes the type out, so this serves the query side: `V.le Roma` reaches
 * the stored `VIALE ROMA` only through this map.
 * `fold` has already removed the full stops, so the keys carry none.
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

const ID_STREET_ABBREV = new Map<string, string>([
	["jl", "jalan"],
	["jln", "jalan"],
	["gg", "gang"],
])

/**
 * Normalizes a street name into an address-point key under the given locale,
 * delegating `us` and `en` to {@link normalizeStreetForKey}.
 *
 * The extract builder and the probe must both call this function, because the
 * key only has to agree with itself.
 */
export function normalizeStreetForKeyLocale(street: string, locale: StreetLocale): StreetKey {
	if (locale === "us" || locale === "en") return normalizeStreetForKey(street)

	if (locale === "zh") return foldHan(street) as StreetKey

	const tokens = fold(street)
		.replaceAll("ß", "ss")
		.replaceAll("-", " ")
		.split(/\s+/)
		.filter((value) => value.length)

	if (!tokens.length) return "" as StreetKey

	switch (locale) {
		case "fr":
			for (let i = 0; i < tokens.length; i++) {
				tokens[i] = FR_STREET_ABBREV.get(tokens[i]!) ?? tokens[i]!
			}
			break
		case "de":
			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i]!

				if (t.endsWith("str") && !t.endsWith("strasse")) {
					tokens[i] = t.replace(/str$/, "strasse")
				}
			}
			break
		case "it":
			// The type is expanded and kept, where `pl` drops it.
			// Dropping a recognized type merges 3.941% of Italy's distinct (comune, street) pairs against
			// 0.131% of Poland's, because ANNCSU writes the type and OSM Poland omits it: `via bevegni`
			// and `salita bevegni` are two streets, while `osiedle Kasprusie` and `Kasprusie` are one.
			//
			// The first token only, since an Italian type word stands at the front
			// and a match deeper in the name is part of the name.
			if (tokens.length > 1) {
				tokens[0] = IT_STREET_TYPE_ABBREV.get(tokens[0]!) ?? tokens[0]!
			}
			break
		case "nl":
			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i]!

				if (t.endsWith("str") && !t.endsWith("straat")) {
					tokens[i] = t.replace(/str$/, "straat")
				}
			}
			break
		case "pl":
			for (let i = 0; i < tokens.length; i++) {
				tokens[i] = tokens[i]!.replaceAll("ł", "l")
			}

			if (tokens.length > 1 && PL_LEADING_TYPE.has(tokens[0]!)) {
				tokens.shift()
			}
			break
		case "id":
			for (let i = 0; i < tokens.length; i++) {
				tokens[i] = ID_STREET_ABBREV.get(tokens[i]!) ?? tokens[i]!
			}
			break
		case "vn":
			for (let i = 0; i < tokens.length; i++) {
				tokens[i] = tokens[i]!.replaceAll("đ", "d").replaceAll("ð", "d")
			}
			break
	}

	return tokens.join(" ") as StreetKey
}

/**
 * Normalize a locality name for address-point keying (fold only — no street semantics).
 */
export function normalizeLocalityForKey(locality: string): NameKey {
	return fold(locality) as NameKey
}

/**
 * Folds a locality name into a {@link NameKey}, using the Han fold for `zh`
 * and {@link normalizeLocalityForKey} otherwise.
 *
 * The Han rule stays out of the shared fold, because adding it there would re-key
 * every 臺 name in existing gazetteer columns.
 */
export function normalizeLocalityForKeyLocale(locality: string, locale: StreetLocale): NameKey {
	return locale === "zh" ? (foldHan(locality) as NameKey) : normalizeLocalityForKey(locality)
}

/**
 * Folds a house number into an address-point key, additionally width-folding
 * and dropping the trailing 號 for `zh`.
 */
export function normalizeHouseNumberForKey(number: string, locale: StreetLocale): string {
	if (locale === "zh") {
		return foldHan(number)
			.replace(/^(\d+)號([之附]\d+)$/u, "$1$2")
			.replace(/號$/u, "")
	}

	return number.trim().toLowerCase()
}

const FRENCH_LEAD_TYPE =
	/^(?:rue|ruelle|av|ave|avenue|boul|bd|boulevard|ch|che|chemin|all[ée]e|imp|impasse|mont[ée]e|c[ôo]te|pl|place|prom|promenade|rang|rte|route|autoroute|carr[eé]|croissant|terrasse|sentier)(?=[\s.-]|$)/i

/**
 * Routes an `en` street surface that leads with a French type word ("boul", "rue", "Ste-")
 * to the `fr` locale, and returns any other base unchanged.
 *
 * It routes on the surface rather than the province so bilingual Canadian extracts fold
 * French abbreviations consistently, and both the extract builder and the probe must call it.
 */
export function streetLocaleForSurface(street: string, base: StreetLocale): StreetLocale {
	return base === "en" && FRENCH_LEAD_TYPE.test(street.trimStart()) ? "fr" : base
}

/**
 * Strips a trailing French arrondissement designator from a folded commune key,
 * so "lyon 1er arrondissement" becomes "lyon".
 *
 * Both the street-centroid extract builder and the probe apply it, and it returns
 * the input unchanged when the strip would leave no text.
 */
export function stripArrondissement(localityNorm: NameKey): NameKey {
	const stripped = localityNorm.replace(/\s+\d+(?:er|e)\s+arrondissement$/, "").trim() as NameKey

	return stripped || localityNorm
}

/**
 * Strips a disambiguating qualifier from a locality name (`Kraubath/Mur`, `Lenk im Simmental`, `Odense S`)
 * for a query-side retry after the exact name misses.
 *
 * It returns "" when no text was stripped, and the result must be refolded with
 * {@link normalizeLocalityForKey} before probing.
 */
export function stripLocalityQualifier(locality: string): string {
	let s = locality.trim()

	if (s.includes("/")) {
		s = s.split("/")[0]!.trim()
	}

	const words = [...s.matchAll(/\S+/gu)].map((match) => ({ value: match[0], index: match.index }))
	let qualifierStart: number | undefined

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
		qualifierStart === undefined &&
		suffix &&
		words.length > 1 &&
		(["S", "N", "E", "W", "V", "Ø", "Sø", "Fyn", "Thy", "Sjælland", "Jylland"].includes(suffix.value) ||
			/^[A-ZÅÄÖ]{2}$/u.test(suffix.value))
	) {
		qualifierStart = suffix.index
	}

	if (qualifierStart !== undefined) {
		s = s.slice(0, qualifierStart).trimEnd()
	}

	s = s.trim()

	return s === locality.trim() ? "" : s
}

/**
 * Folds a numbered-route designator in a street key to `us route N` or `state route N`,
 * so `US Hwy 5` and `US route 5` key alike.
 *
 * Only digit-leading route numbers after a `us`, `state` or two-letter prefix fold,
 * so a bare `route N` stays unfolded rather than guessing the designator.
 */
export function canonicalizeRouteKey(streetNorm: StreetKey): RouteKey {
	const match = /^(us|state|[a-z]{2}) (?:route|rte|rt|highway|hwy) (\d.*)$/.exec(streetNorm)

	if (!match) return streetNorm as string as RouteKey

	return `${match[1] === "us" ? "us" : "state"} route ${match[2]}` as RouteKey
}

const CANONICAL_TYPE_WORDS: ReadonlySet<string> = new Set(
	[...US_STREET_SUFFIX_LOOKUP.values()].map((v) => v.toLowerCase())
)

/**
 * Lists the lookup keys to probe for a street span, most literal first,
 * starting with the primary normalized key.
 *
 * For `us` and `en` it adds recovery forms for a doubled type ("Saint Pauls PL St")
 * and a leading Saint/St swap, since sources preserve whichever register they spell.
 */
export function streetKeyVariants(street: string, locale: StreetLocale = "us"): StreetKey[] {
	const primary = locale === "us" ? normalizeStreetForKey(street) : normalizeStreetForKeyLocale(street, locale)
	const variants: StreetKey[] = primary ? [primary] : []

	if (!primary || (locale !== "us" && locale !== "en")) return variants

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

	return variants
}
