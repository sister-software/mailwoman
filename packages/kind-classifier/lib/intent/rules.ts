/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * ROAD_TO_V9 §4 — the query-intent rules, with the same `(input, shape) => number` interface as
 * `rules.ts` and the same bitter-lesson invariant: universal structural patterns and bounded linguistic
 * categories only, never a place-name dictionary, with the POI synonym table injected exactly as
 * `poi.ts` does it.
 *
 * `bare_toponym` and `route_pair` score below the structural kind that already owns their population
 * (`locality_only`, 0.85), so they surface in `QueryKindResult.alternatives` and never as the top kind;
 * the top kind is the only thing the coordinator routes on, so pinning it is what makes these additions
 * answer-neutral on the bare-city-name register, and the intent they carry travels on the marker.
 *
 * `near_me` does win its top slot (0.91), because there is no incumbent worth preserving: a query
 * ending "near me" is not a locality.
 */

import type { NormalizedInputLite, QueryShapeSegmentsView as QueryShapeLike } from "@mailwoman/query-shape"

import { carriesLetter, isDisqualifyingStreetSuffix, MAX_LOCALITY_ONLY_LENGTH, wordsOf } from "#rules"
/**
 * Both refinement kinds sit a whole confidence step below `locality_only`'s 0.85
 * so no float-comparison accident can flip the top slot.
 */
const BARE_TOPONYM_CONFIDENCE = 0.84

/**
 * Lower still, and for a second reason on top of the ranking discipline: a route pair is
 * a hypothesis whose competing reading (locality + region) is more common in this corpus.
 */
const ROUTE_PAIR_CONFIDENCE = 0.55

/**
 * Above `landmark`'s venue ceiling (0.88) and above `poi_query`'s anchored band (0.90),
 * because a deictic tail is a stronger signal than either shape heuristic:
 * no other rule explains why "me" ends the string.
 */
const NEAR_ME_CONFIDENCE = 0.91

/**
 * Word ceiling for a single bare toponym: four covers the long tail that exists as one
 * place name ("Newcastle upon Tyne", "Sault Sainte Marie", "Las Palmas de Gran Canaria"),
 * and past it the input carries more than a name.
 */
const MAX_BARE_TOPONYM_WORDS = 4

/**
 * Toponymic head particles — the bounded linguistic category that makes a multi-token
 * string one place name, with the same boundary as `@mailwoman/phrase-grouper`'s
 * `PLACE_NAME_PARTICLES` (which covers the infix glue `de`, `am`, `aan den`) and the one
 * job of keeping `route_pair` off "New York", "San Francisco", "Fort Worth" and their kin.
 *
 * It is a closed morphological class rather than a gazetteer, so growing it with actual place
 * names is the wrong move; it is case-folded on read, because "new york" is the same query.
 */
const TOPONYM_HEAD_PARTICLES: ReadonlySet<string> = new Set([
	// English
	"new",
	"old",
	"fort",
	"ft",
	"port",
	"lake",
	"mount",
	"mt",
	"north",
	"south",
	"east",
	"west",
	"upper",
	"lower",
	"great",
	"little",
	"saint",
	"st",
	"st.",
	// Romance
	"san",
	"santa",
	"santo",
	"são",
	"sao",
	"los",
	"las",
	"el",
	"la",
	"le",
	"les",
	"villa",
	"rio",
	"nueva",
	"nuevo",
	"puerto",
	"ciudad",
	"campo",
	"monte",
	"castel",
	"borgo",
	// Germanic / Nordic
	"bad",
	"sankt",
	"neu",
	"alt",
	"groß",
	"gross",
	"klein",
	"ober",
	"unter",
	"nieuw",
	"oud",
	"ny",
	"stor",
	"lille",
	"sint",
	// Definite article as a head — "The Valley" (Anguilla), "The Hague", "The Bottom".
	"the",
	// Generic toponymic heads outside the Latin/Germanic families, each a common noun in its
	// own language — Semitic "tel" (mound), Malay "kuala" (confluence), Khmer "phnom" (hill) —
	// that heads a place name the way "mount" does; see `mailwoman/test/kind-intent-invariance.test.ts`.
	"tel",
	"kuala",
	"phnom",
	"cape",
	"isle",
	"isla",
	"ilha",
])

/**
 * Generic toponymic tail nouns — the other half of the same bounded morphological
 * class, so a place name whose last token is a settlement/landform generic
 * ("Belize City", "George Town", "Palm Springs") is one name rather than two.
 */
const TOPONYM_TAIL_NOUNS: ReadonlySet<string> = new Set([
	"city",
	"town",
	"ville",
	"village",
	"borough",
	"springs",
	"falls",
	"beach",
	"heights",
	"valley",
	"island",
	"islands",
	"bay",
	"harbour",
	"harbor",
	"park",
	"hills",
	"river",
	"creek",
	"point",
	"stadt",
	"burg",
])

/**
 * Deictic locator tails — "near me", "nearby", "around here", "in my area" —
 * the bounded class `preposition + a reference to the asker`, where `me`, `here`,
 * `my <noun>` are function words rather than places.
 *
 * Anchored to the end of the string (`$`) on purpose: the query names no anchor,
 * so anything after the locator is an anchor and disqualifies it.
 *
 * Linear by construction: every alternative begins with a required literal
 * and the only quantifiers are bounded `\s+` runs between two required literals
 * or trailing before `$`, with no unbounded-whitespace-then-literal prefix
 * (the `js/polynomial-redos` shape; see `ANCHOR_SEPARATOR` in `poi.ts` for the same analysis).
 */
const DEICTIC_LOCATOR_TAIL =
	/\b(?:near|close\s+to|next\s+to|around|by|closest\s+to|nearest\s+to)\s+(?:me|us|here|my\s+(?:location|position|area|place|house|home))\s*$/

/**
 * The adverbial half of the same class, where the deixis is baked into the word
 * rather than carried by a preposition.
 */
const DEICTIC_ADVERB_TAIL =
	/\b(?:nearby|near\s?by|close\s+by|around\s+here|in\s+my\s+(?:area|neighborhood|neighbourhood))\s*$/

function hasDeicticTail(lowercased: string): boolean {
	return DEICTIC_LOCATOR_TAIL.test(lowercased) || DEICTIC_ADVERB_TAIL.test(lowercased)
}

/**
 * The conditions `bare_toponym` and `route_pair` share: no address grammar of any kind,
 * one segment, alpha throughout.
 *
 * @returns the word list when the input clears them, `null` when it does not;
 * deliberately a superset of `scoreLocalityOnly`'s conditions, so `bare_toponym` is a
 * strict refinement of `locality_only` and can never fire where `locality_only` did not.
 */
function bareNameWords(input: NormalizedInputLite, shape: QueryShapeLike): string[] | null {
	const text = input.normalized.trim()

	if (!text || text.length > MAX_LOCALITY_ONLY_LENGTH) return null

	// A recognized postcode/known format is address grammar, so no bare toponym survives it.
	if (shape.knownFormats.length) return null

	// `alpha` excludes every house number and postcode by construction, the cheapest statement of
	// "no address grammar"; it is silent about whether a name is present, so the letter test stands
	// beside it because `foldInputClass` answers `alpha` for input carrying no classified token.
	if (shape.characterClass !== "alpha" || !carriesLetter(text)) return null

	// A comma is the admin-context marker ("Paris, FR"), so one segment or the name is not bare.
	if ((shape.segments?.length ?? 1) !== 1) return null

	const lowercased = text.toLowerCase()

	if (hasDeicticTail(lowercased)) return null

	const words = wordsOf(text)

	if (!words.length || words.length > MAX_BARE_TOPONYM_WORDS) return null

	for (const word of words) {
		if (isDisqualifyingStreetSuffix(word)) return null
	}

	return words
}

/**
 * `bare_toponym` rule: a single coherent place-name carrying no address grammar, feeding the
 * declared-ambiguity path without asserting which place — that is the resolver's question,
 * decided by the answer's dominance margin in `mailwoman/query-intent.ts`.
 */
export function scoreBareToponym(input: NormalizedInputLite, shape: QueryShapeLike): number {
	return bareNameWords(input, shape) ? BARE_TOPONYM_CONFIDENCE : 0
}

/**
 * `route_pair` rule: exactly two toponym-shaped tokens with no token between them.
 *
 * The known confound is structural and unfixable here: "Paris London" and "Moscow Idaho" are
 * the same string shape, and separating them needs the gazetteer fact that Idaho is a region,
 * which is why ROAD_TO_V9 §4.3 specifies classification plus a declared fork, never a router —
 * both readings are named in the marker, neither wins, and the resolver keeps answering as it did.
 *
 * The one structurally separable class is the two-token single name ("New York", "Fort Worth")
 * carrying a toponymic head particle, and that guard is what keeps the fork off the common case.
 */
export function scoreRoutePair(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const words = bareNameWords(input, shape)

	if (!words || words.length !== 2) return 0

	const [first, second] = [words[0]!.toLowerCase(), words[1]!.toLowerCase()]

	// Reduplication — "Pago Pago", "Baden-Baden", "Walla Walla" — is a universal single-name
	// signal that needs no lexicon, because nobody travels from a place to itself.
	if (first === second) return 0

	if (TOPONYM_HEAD_PARTICLES.has(first) || TOPONYM_HEAD_PARTICLES.has(second)) return 0

	if (TOPONYM_TAIL_NOUNS.has(second)) return 0

	return ROUTE_PAIR_CONFIDENCE
}

/**
 * `near_me` rule: a subject plus a deictic locator, with no anchor; a non-empty subject
 * is required, so a bare "near me" stays with the `landmark` leaders rule.
 */
export function scoreNearMe(input: NormalizedInputLite, _shape: QueryShapeLike): number {
	const lowercased = input.normalized.trim().toLowerCase()

	if (!hasDeicticTail(lowercased)) return 0

	// The subject is everything before the locator, and `hasDeicticTail` already anchored
	// the match to the end, so the first match index is where the subject stops.
	const match = DEICTIC_LOCATOR_TAIL.exec(lowercased) ?? DEICTIC_ADVERB_TAIL.exec(lowercased)

	if (!match) return 0

	return lowercased.slice(0, match.index).trim() ? NEAR_ME_CONFIDENCE : 0
}

/**
 * The subject of a `near_me` query — the category or thing the asker wants, with the locator stripped,
 * and empty when the rule would not have fired; used to build the marker's evidence, never to route.
 */
export function nearMeSubject(input: NormalizedInputLite): string {
	const trimmed = input.normalized.trim()
	const lowercased = trimmed.toLowerCase()
	const match = DEICTIC_LOCATOR_TAIL.exec(lowercased) ?? DEICTIC_ADVERB_TAIL.exec(lowercased)

	if (!match) return ""

	return trimmed.slice(0, match.index).trim()
}
