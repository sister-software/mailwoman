/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   THE street normalizer for the address-point tier (#476). One function, used by BOTH the extract
 *   builder (`scripts/build-address-point-extract.ts`) and the lookup tier (`address-point.ts`) —
 *   never two implementations (the PLACETYPE_ORDER lesson: parallel copies silently corrupt).
 *
 *   Normalization contract (deliberately aggressive — both sides apply the same function, so
 *   collisions only need to be _consistent_, not linguistically perfect):
 *
 *   1. Lowercase, NFKD-fold diacritics, collapse whitespace, strip punctuation (periods, commas,
 *        apostrophes).
 *   2. Expand USPS directional abbreviations at the FIRST and LAST token position (`n` → `north`, `se` →
 *        `southeast`) — Overture sources abbreviate inconsistently.
 *   3. Canonicalize a trailing USPS street-type token via the codex suffix table to its canonical full
 *        form (`st`/`str`/`street` → `street`).
 *
 *   Numbered streets are left as digits (`5th` stays `5th`); a SPELLED ordinal before a street suffix
 *   folds to its digit form (`tenth street` → `10th street`, #723) so the grid-city ordinal
 *   cross-streets the source data spells with digits become reachable.
 */

import { AbbreviationToDirectional, US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us"
import type { Tagged } from "type-fest"

/**
 * A place name folded by {@link normalizeLocalityForKey} — the value stored in, and required to probe, every
 * `name_key`-style column: the candidate gazetteer, the postal-city side-index, the street-centroid extract, an
 * ancestor chain's `parent_name_key`, and the address-point locality scope.
 *
 * The brand is here because the fold is applied at BUILD time and is therefore mandatory at QUERY time, while a
 * near-miss approximation of it (`toLowerCase()`, `trim()`) is still a `string`: it binds to the parameter, returns
 * fewer rows, and the shortfall reads as a coverage gap in the data rather than a defect in the probe. Requiring the
 * brand at the boundary turns that silent under-match into a compile error. Mint one only by calling the fold.
 */
export type NameKey = Tagged<string, "NameKey">

/**
 * A street name folded by {@link normalizeStreetForKey} / {@link normalizeStreetForKeyLocale} — the value stored in a
 * `street_norm` address-point column and required to probe it.
 *
 * Distinct from {@link RouteKey}: the route fold is a FURTHER canonicalization applied to some columns and not others,
 * so the two are not interchangeable even though both are folded streets.
 */
export type StreetKey = Tagged<string, "StreetKey">

/**
 * A street key that has additionally passed {@link canonicalizeRouteKey} — the numbered-route canonical form.
 *
 * A separate brand from {@link StreetKey} because it identifies a DIFFERENT set of columns, and the two folds disagree
 * exactly on the rows that motivate the route fold: binding a plain street key to a route-folded column silently misses
 * every row whose source spelled the route differently, which is the miss class the fold exists to close.
 */
export type RouteKey = Tagged<string, "RouteKey">

/**
 * Token count a street must exceed before its trailing pair is merged. At or below it the pair IS the whole street
 * name, and merging would leave nothing to match on.
 */
const MIN_TOKENS_FOR_TAIL_MERGE = 3

/**
 * Spelled ordinal street names → their digit-ordinal form ("tenth" → "10th"), applied ONLY when a street-type suffix
 * follows (#723 admin-tail) — so the ordinal cross-streets common in grid cities ("Tenth Street", "Fifth Avenue") match
 * the extracts' digit keys, WITHOUT rewriting ordinal-WORD names where the next token is not a suffix ("First National
 * Bank Rd" stays "first national …"). Digit-source extracts are unaffected (a digit token isn't in this map), so the
 * existing keys need no rebuild; a future rebuild folds any spelled-source key the same way (the one-function
 * discipline).
 */
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

/**
 * Lowercase + diacritic-fold + punctuation strip + whitespace collapse.
 */
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
 * Normalize a street name for address-point keying. Same function at build time and lookup time — see module docstring
 * for the contract.
 */
export function normalizeStreetForKey(street: string): StreetKey {
	const tokens = fold(street).split(" ")

	if (!tokens.length) return "" as StreetKey

	// Spelled-ordinal street names → digit form when a street suffix follows ("Tenth Street" →
	// "10th street", #723). Gated on the next token being a suffix so ordinal-WORD names are untouched.
	for (let i = 0; i < tokens.length - 1; i++) {
		const digit = SPELLED_ORDINAL_TO_DIGIT.get(tokens[i]!)

		if (digit && US_STREET_SUFFIX_LOOKUP.has(tokens[i + 1]!)) {
			tokens[i] = digit
		}
	}

	// Directional expansion at the edges only ("N Main St" / "Main St N" — never interior
	// tokens, where "W" may be an initial in a person-named street). The codex expands
	// compounds to two words ("SE" → "SOUTH EAST"); we key on the spaceless form
	// ("southeast"), and also merge an already-written two-token pair ("South East …").
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

	// Street-type canonicalization via the codex table (lowercase keys, UPPER canonical
	// values). The suffix is usually the last token, but sits second-to-last when a trailing
	// directional follows ("Main St N") — check both positions, canonicalize the first hit.
	for (const at of [tokens.length - 1, tokens.length - 2]) {
		if (at < 1) continue // never canonicalize the only/first token ("Street Road" exists)
		const canonical = US_STREET_SUFFIX_LOOKUP.get(tokens[at]!)

		if (canonical) {
			tokens[at] = canonical.toLowerCase()

			break
		}
	}

	return tokens.join(" ") as StreetKey
}

/**
 * Street-name locale for the address-point key. The US path is the full USPS pipeline ({@link normalizeStreetForKey});
 * the international paths fold + apply a SMALL, consistent per-locale type-token canonicalization. Same discipline as
 * the US normalizer: build side and probe side call the identical function, so the key only needs to be CONSISTENT, not
 * linguistically perfect — a folded "rue du chevaleret" keys the same on both sides whether or not we reorder the
 * article, so no salient-token / multi-key index is built yet (deferred until probing shows the normalizer can't absorb
 * the false-negatives).
 */
export type StreetLocale = "us" | "en" | "fr" | "de" | "nl" | "pl" | "vn" | "id"

/**
 * Country → street-locale registry surface for the acquisition SDKs (BAN, OSM). Each SDK keeps its own map — membership
 * is a per-register decision — and this factory owns the lookup discipline: throw for an unsupported country rather
 * than silently folding with the wrong rules, because a extract built with the wrong normalizer keys every street
 * incorrectly and looks fine until a probe misses. `label` is the SDK's own registration instructions, appended to the
 * error verbatim.
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

/**
 * French street-type abbreviations → canonical full form, applied per token after {@link fold}. French address types
 * LEAD the name ("Av. de…", "Bd …", "Pl. …") and "St"/"Ste" abbreviate Saint/Sainte inside names ("Rue St-Honoré" →
 * "rue saint honore"). fold() has already stripped the trailing period, so the keys are point-free ("av", "bd").
 */
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

/**
 * Polish leading street-type tokens, STRIPPED rather than expanded. Measured on the 5.56M-row PL OSM extract
 * (2026-08-19): OSM Poland tags `addr:street` BARE — `ulica%` covers 22 rows and `ul.%` eight, so an EXPANSION rule
 * makes a typed query ("ul. Świętokrzyska" → "ulica swietokrzyska") miss the 3,846 bare "swietokrzyska" rows. Stripping
 * the leading type on BOTH sides keys typed and bare surfaces identically. The full words are stripped too: the
 * aleja/plac/osiedle populations (48,597 / 26,815 / 39,552 rows) spell the word out, and "Plac Zamkowy" must key the
 * same as a query's "plac zamkowy" or bare "Zamkowy". Never stripped when it is the only token.
 */
const PL_LEADING_TYPE = new Set(["ul", "ulica", "al", "aleja", "aleje", "pl", "plac", "os", "osiedle"])

/**
 * Indonesian street-type abbreviations → canonical full form, leading position ("Jl. Thamrin", "Gg. Waru").
 */
const ID_STREET_ABBREV = new Map<string, string>([
	["jl", "jalan"],
	["jln", "jalan"],
	["gg", "gang"],
])

/**
 * Normalize a street name for the address-point key in a non-US locale. Same function build-side and probe-side (the
 * one-function discipline). US delegates to {@link normalizeStreetForKey}.
 *
 * - **en** — the shared English address-key pipeline (directionals + suffix aliases), currently identical to US.
 * - **fr** — fold + expand leading type abbreviations and Saint/Sainte (token map).
 * - **de** — fold + ß→ss + canonicalize the GLUED `-str(.)` suffix to `-strasse` ("Lindenstr." → "lindenstrasse",
 *   "Lindenstraße" → "lindenstrasse"); an already-full "-strasse" is left intact.
 * - **nl** — fold + canonicalize the glued `-str` suffix to `-straat` ("Kerkstr." → "kerkstraat").
 * - **pl** — fold + ł→l (Ł does not NFKD-decompose, so the generic fold keeps it and an undiacritized query would miss;
 *   every other Polish diacritic is a combining form the fold already strips) + STRIP the leading type token — see
 *   {@link PL_LEADING_TYPE} for the measured reason expansion was wrong for this source.
 * - **vn** — fold + đ→d AND ð→d (both non-decomposing, and OSM mixes the two codepoints inside single values — see the
 *   branch comment). Deliberately NO type-abbreviation map yet: the common abbreviation is the single letter "Đ." for
 *   Đường, and expanding a bare folded "d" token would rewrite initials — measure the miss rate on the built extract
 *   before adding anything.
 * - **id** — fold + expand leading type abbreviations (jl/jln→jalan, gg→gang); Indonesian street surfaces are otherwise
 *   ASCII-clean.
 */
export function normalizeStreetForKeyLocale(street: string, locale: StreetLocale): StreetKey {
	if (locale === "us" || locale === "en") return normalizeStreetForKey(street)

	// Hyphen → space so a compound name keys the same whether the source or the query writes the
	// hyphen ("Champs-Élysées", "St-Honoré") or a space — both sides fold identically, so this is pure
	// robustness. It also splits a hyphenated abbreviation ("St-Honoré" → "st honore") into tokens the
	// per-locale type/Saint map can see. Letter maps for non-decomposing letters (ß, ł, đ) live in the
	// per-locale branches, NEVER here: widening the shared pipeline would silently change keys under
	// every already-built extract of the other locales.
	const tokens = fold(street)
		.replaceAll("ß", "ss")
		.replaceAll("-", " ")
		.split(/\s+/)
		.filter((value) => value.length > 0)

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
			// đ (U+0111, d-with-stroke) AND ð (U+00F0, eth): OSM Vietnamese data mixes the two visually
			// identical codepoints inside single values — the 2026-08-19 extract measured `Đường Trần Hưng
			// Đạo` carrying d-with-stroke at the front and ETH in `Đạo`, splitting the country's most
			// common street into two keys with the MAJORITY variant (630 vs 421 rows) unreachable by a
			// correctly-typed query. No abbreviation map — see the locale table.
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
 * Leading French street-type token. French types LEAD the name ("avenue du Parc", "boul Saint-Laurent") while English
 * types TRAIL ("Fifth Avenue", "Grosvenor Place"), so a leading type-token is the discriminating signal — "1 Avenue NE"
 * starts with a digit and never matches. The separator lookahead is explicit rather than `\b` because a word boundary
 * after an accented final letter ("carré") is not one to an ASCII-word `\b`.
 */
const FRENCH_LEAD_TYPE =
	/^(?:rue|ruelle|av|ave|avenue|boul|bd|boulevard|ch|che|chemin|all[ée]e|imp|impasse|mont[ée]e|c[ôo]te|pl|place|prom|promenade|rang|rte|route|autoroute|carr[eé]|croissant|terrasse|sentier)(?=[\s.-]|$)/i

/**
 * Surface-driven street-locale ROUTER for bilingual extracts — the Québec finishing move on the CA rooftop extract.
 *
 * A country registers ONE street locale, but Canada's street surfaces are two languages: under the `en` rules a French
 * surface passes through mostly unchanged (both sides fold identically, so those rows stay reachable), and what breaks
 * is abbreviation variance — the `en` rules cannot fold "boul"/"Ste-" to the full French word, so an abbreviated query
 * misses a full-word row and vice versa. Routing on the SURFACE (not the province) also carries bilingual NB and the
 * French street names outside Québec for free.
 *
 * ONE function, called by the extract BUILDER and the query PROBE alike — the #861 discipline: routing is part of the
 * fold contract, and two transcriptions of this predicate would diverge exactly where it matters. Only an `en` base
 * re-routes: a `fr`/`de`/`nl` extract already speaks its own rules, and the US pipeline stays untouched.
 *
 * Measured basis (CA extract, 2026-08-19): 183,963 distinct surfaces, 43,762 French-lead; 29,682 fold differently under
 * fr-vs-en (888,265 rows), and the non-French half of those are English surfaces this router keeps on `en` unchanged.
 */
export function streetLocaleForSurface(street: string, base: StreetLocale): StreetLocale {
	return base === "en" && FRENCH_LEAD_TYPE.test(street.trimStart()) ? "fr" : base
}

/**
 * Strip a trailing French arrondissement designator from a FOLDED commune key ("paris 8e arrondissement" → "paris",
 * "lyon 1er arrondissement" → "lyon", "marseille 10e arrondissement" → "marseille"). Paris, Lyon and Marseille are the
 * only French communes subdivided into _arrondissements municipaux_; a national register (BAN) names each row per
 * arrondissement, but a query names the base commune ("Place Bellecour, Lyon", never "…, Lyon 2e"). Applied on BOTH
 * sides of the #1042 street-centroid key — build-side (deriving the `locality_base` column) and query-side (folding the
 * probe commune) — so the two agree by construction (the one-function discipline). The {@link NameKey} parameter is the
 * enforcement of "must already be folded": stripping an arrondissement off an unfolded surface yields a key neither
 * side stores. A no-op for every other commune, and the strip leaves a fold fixed point, so the result is still a
 * {@link NameKey}. Returns the input unchanged if the strip would empty it.
 */
export function stripArrondissement(localityNorm: NameKey): NameKey {
	const stripped = localityNorm.replace(/\s+\d+(?:er|e)\s+arrondissement$/, "").trim() as NameKey

	return stripped || localityNorm
}

/**
 * Strip a locality QUALIFIER for a query-side fallback — when an OA locality's exact normalized name misses the
 * gazetteer's canonical name, retry with the qualifier removed. OA address data carries disambiguating qualifiers the
 * gazetteer's canonical name omits: Austrian `Kraubath/Mur` and `Hart b.Graz` → `Hart`; Swiss `Lenk im Simmental` →
 * `Lenk`, `Roche VD` → `Roche`; Danish `Odense S`, `Hurup Thy`. A FALLBACK ONLY — the exact name is tried first, and
 * the region-bbox disambiguation resolves any base-name ambiguity downstream. The candidate table is unchanged (this is
 * purely query-side); feed the result back through {@link normalizeLocalityForKey}. Returns "" when nothing was stripped
 * (no point re-probing the identical key).
 *
 * Measured (`scripts/eval/candidate-recall.ts --strip-fallback`, EU OA holdouts): recovers AT 74.1→88.2% (+14.1pp), DK
 * 91.5→96.2%, CH 90.4→92.6%; +1.3pp overall (diluted by the already-100% locales). Conservative by design — only the
 * qualifier forms above; FI/PT/SI misses are untouched.
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
 * Fold numbered-route designators to a canonical key, applied AFTER {@link normalizeStreetForKey}. Sources disagree
 * systematically on how they spell a route: TIGER says `State Rte 100` / `US Hwy 5` where E911/Overture say `VT ROUTE
 * 100` / `US ROUTE 5` — the dominant street-name miss class in the #483 interpolation eval (rural addresses live on
 * routes). `us <designator> N…` folds to `us route N…`; `state <designator> N…` and `<2-letter-prefix> <designator> N…`
 * (the state abbreviation form) fold to `state route N…`. Only digit-leading route numbers fold — `State Street` and
 * friends never match.
 *
 * Used by BOTH the segment-extract builder (`scripts/build-interpolation-extract.ts`) and the interpolation lookup —
 * same one-function discipline as {@link normalizeStreetForKey}. The address-point tier (#476) does NOT apply it yet:
 * adopting it there requires a extract rebuild (noted on #483).
 *
 * A same-numbered US and state route stay DISTINCT keys (`us route 5` vs `state route 5`); only the BARE `route N` form
 * is ambiguous (designator unknown) and it stays unfolded — a bare-route query therefore misses rather than guessing a
 * designator.
 */
export function canonicalizeRouteKey(streetNorm: StreetKey): RouteKey {
	const match = /^(us|state|[a-z]{2}) (?:route|rte|rt|highway|hwy) (\d.*)$/.exec(streetNorm)

	// A street naming no route is already its own route key. {@link StreetKey} and {@link RouteKey} are
	// SIBLING brands rather than nested ones — precisely so neither column accepts the other's key — so
	// re-minting here is an explicit hop through the unbranded string.
	if (!match) return streetNorm as string as RouteKey

	return `${match[1] === "us" ? "us" : "state"} route ${match[2]}` as RouteKey
}

/**
 * The canonical street-type words (lowercase) — the VALUE side of the codex suffix table. Membership means "this
 * normalized token is a fully-spelled street type" ("place", "street", "road" …), which is how the doubled-type
 * collapse below recognizes its shape without any parse-tree knowledge.
 */
const CANONICAL_TYPE_WORDS: ReadonlySet<string> = new Set(
	[...US_STREET_SUFFIX_LOOKUP.values()].map((v) => v.toLowerCase())
)

/**
 * Ordered lookup-key variants for a US/EN street span — the primary normalized key first, then the null-only recovery
 * forms a reader may probe when the primary misses. Two register mismatches motivate them, both measured on live
 * queries (2026-08-14):
 *
 * - **Doubled type** — a user types the type twice ("Saint Pauls PL St"), and the normalizer canonicalizes only the LAST
 *   type token, leaving `saint pauls pl street`, which matches nothing anywhere. The signature is visible in the key
 *   itself: a canonical type word in last position DIRECTLY after an uncanonicalized type abbreviation. The variant
 *   drops the trailing word and canonicalizes what remains (`saint pauls place`). A street genuinely named with two
 *   types keys identically on both sides and is caught by the primary probe first.
 * - **Saint↔St register split** — the artifacts preserve each SOURCE's spelling (NYC situs keys `st pauls place`, Nassau
 *   keys `saint pauls place`), and a query arrives in whichever register the user typed. A leading `saint` or `st`
 *   token is swapped for its sibling; leading position only — a leading `st` is always the hagionym in US street names,
 *   and interior tokens ("Mount Saint Helens Dr") are out of scope until measured.
 *
 * Deduplicated and ordered most-literal-first, so probing the list in order preserves the primary key's precedence.
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

	// Snapshot before the swap pass — it appends while reading, and iterating the live array would
	// re-visit its own additions.
	const preSwap = variants.slice()

	for (const variant of preSwap) {
		const [head, ...rest] = variant.split(" ")
		const swapped = head === "saint" ? "st" : head === "st" ? "saint" : null

		if (swapped && rest.length) {
			// Substituting a leading hagionym token in an already-normalized key leaves a fold fixed point —
			// the suffix pass never rewrites position 0 — so the swap yields a {@link StreetKey} without
			// re-folding.
			const candidate = [swapped, ...rest].join(" ") as StreetKey

			if (!variants.includes(candidate)) {
				variants.push(candidate)
			}
		}
	}

	return variants
}
