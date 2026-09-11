/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ROAD_TO_V9 §4 — the query-INTENT rules. Same contract as `rules.ts` (a `(input, shape) => number`
 *   in [0, 1], 0 when the rule does not fire) and the same bitter-lesson invariant: universal
 *   structural patterns and bounded linguistic categories only, never a place-name dictionary. The
 *   one lexicon these kinds consult — the POI synonym table — is INJECTED, exactly as `poi.ts`
 *   already does it.
 *
 *   ## Why two of these three deliberately lose
 *
 *   `bare_toponym` and `route_pair` are scored BELOW the structural kind that already owns their
 *   population (`locality_only`, 0.85). They therefore surface in `QueryKindResult.alternatives` and
 *   never as the top kind. That is not timidity — it is the D-rule discharge. The top kind is the
 *   only thing the coordinator routes on (`deriveInputMode`, `canShortCircuit`, the POI branch), so
 *   pinning it is what makes these additions provably answer-neutral on the bare-city-name register,
 *   which is the single largest population in map search. The intent they carry travels on the
 *   marker instead, where it is advisory by construction.
 *
 *   `near_me` DOES win its top slot (0.91), because there is no incumbent worth preserving: a query
 *   ending "near me" is not a locality and answering it as one is the bug.
 */

import type { NormalizedInputLite, QueryShapeSegmentsView as QueryShapeLike } from "@mailwoman/query-shape"

import { isDisqualifyingStreetSuffix, MAX_LOCALITY_ONLY_LENGTH, wordsOf } from "#rules"
/**
 * `locality_only` scores 0.85. Both refinement kinds sit under it by a whole confidence step so no float-comparison
 * accident can flip the top slot, and so the gap reads as deliberate to the next person.
 */
const BARE_TOPONYM_CONFIDENCE = 0.84

/**
 * Lower still, and for a second reason on top of the ranking discipline: a route pair is a HYPOTHESIS about a query
 * whose competing reading (locality + region) is more common in this corpus. The number states that.
 */
const ROUTE_PAIR_CONFIDENCE = 0.55

/**
 * Above `landmark`'s venue ceiling (0.88) and above `poi_query`'s anchored band (0.90), because a deictic tail is a
 * stronger signal than either shape heuristic: nothing else in the vocabulary explains why "me" is at the end of the
 * string.
 */
const NEAR_ME_CONFIDENCE = 0.91

/**
 * Word ceiling for a single bare toponym. Four covers the long tail that actually exists as one place name ("Newcastle
 * upon Tyne", "Sault Sainte Marie", "Las Palmas de Gran Canaria"); past it the input is carrying more than a name.
 */
const MAX_BARE_TOPONYM_WORDS = 4

/**
 * Toponymic HEAD particles — the bounded linguistic category that makes a multi-token string ONE place name.
 *
 * Same justification, and the same boundary, as `@mailwoman/phrase-grouper`'s `PLACE_NAME_PARTICLES` (which covers the
 * INFIX glue: `de`, `am`, `aan den`). This set covers the PREFIX heads, and it exists for exactly one job: keeping
 * `route_pair` off "New York", "San Francisco", "Fort Worth" and their kin. It is a closed morphological class, not a
 * gazetteer — growing it with actual place names is the wrong move, and the pressure for that belongs on the resolver.
 *
 * Case-folded on read, because lowercase is the primary user register and "new york" is the same query.
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
	// Generic toponymic heads outside the Latin/Germanic families, added because the 306-case corpus MEASURED them
	// (see `mailwoman/test/kind-intent-invariance.test.ts`): each is a common noun in its own language — Semitic "tel"
	// (mound), Malay "kuala" (confluence), Khmer "phnom" (hill) — that heads a place name the way "mount" does.
	"tel",
	"kuala",
	"phnom",
	"cape",
	"isle",
	"isla",
	"ilha",
])

/**
 * Generic toponymic TAIL nouns — the other half of the same bounded morphological class. "Belize City", "George Town",
 * "Cape Town", "Palm Springs": a place name whose last token is a settlement/landform generic is ONE name, not two.
 *
 * Measured additions, same as the heads above: `city`, `town` and `valley` each came off a real corpus row that was
 * forking wrongly.
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
 * Deictic locator tails — "near me", "nearby", "around here", "in my area".
 *
 * The class is `preposition + a reference to the ASKER`, which is why it is bounded and why it is safe: `me`, `here`,
 * `my <noun>` are function words, not places. Anchored to the END of the string (`$`) on purpose — the whole point of
 * the kind is that the query names no anchor, so anything AFTER the locator is an anchor and disqualifies it.
 *
 * Linear by construction: every alternative begins with a required literal, and the only quantifiers are bounded `\s+`
 * runs BETWEEN two required literals or trailing before `$`. No unbounded-whitespace-then-literal prefix, which is the
 * `js/polynomial-redos` shape (see the `ANCHOR_SEPARATOR` docstring in `poi.ts` for the same analysis).
 */
const DEICTIC_LOCATOR_TAIL =
	/\b(?:near|close\s+to|next\s+to|around|by|closest\s+to|nearest\s+to)\s+(?:me|us|here|my\s+(?:location|position|area|place|house|home))\s*$/

/**
 * The adverbial half of the same class — no preposition, the deixis is baked into the word.
 */
const DEICTIC_ADVERB_TAIL =
	/\b(?:nearby|near\s?by|close\s+by|around\s+here|in\s+my\s+(?:area|neighborhood|neighbourhood))\s*$/

/**
 * True when the input carries a deictic locator tail in EITHER form.
 */
function hasDeicticTail(lowercased: string): boolean {
	return DEICTIC_LOCATOR_TAIL.test(lowercased) || DEICTIC_ADVERB_TAIL.test(lowercased)
}

/**
 * The conditions `bare_toponym` and `route_pair` share: no address grammar of any kind, one segment, alpha throughout.
 *
 * Returns the word list when the input clears them, `null` when it does not. Deliberately a SUPERSET of
 * `scoreLocalityOnly`'s conditions (which admit two segments), so `bare_toponym` is a strict refinement of
 * `locality_only` and can never fire where `locality_only` did not — the property `intent-rules.test.ts` asserts and
 * the reason the ranking discipline above is enough to keep the top kind pinned.
 */
function bareNameWords(input: NormalizedInputLite, shape: QueryShapeLike): string[] | null {
	const text = input.normalized.trim()

	if (!text || text.length > MAX_LOCALITY_ONLY_LENGTH) return null

	// A recognized postcode/known format IS address grammar. Nothing bare survives this.
	if (shape.knownFormats.length) return null

	// `alpha` excludes every house number and every postcode by construction — the cheapest available statement of
	// "no address grammar", and it costs no lexicon.
	if (shape.characterClass !== "alpha") return null

	// A comma is the admin-context marker ("Paris, FR"). One segment, or the name is not bare.
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
 * `bare_toponym` rule: a single coherent place-name carrying no address grammar.
 *
 * Feeds the declared-ambiguity path. The rule itself asserts nothing about WHICH place — that is the resolver's
 * question, and `mailwoman/query-intent.ts` is where the answer's dominance margin decides whether the ambiguity gets
 * declared.
 */
export function scoreBareToponym(input: NormalizedInputLite, shape: QueryShapeLike): number {
	return bareNameWords(input, shape) ? BARE_TOPONYM_CONFIDENCE : 0
}

/**
 * `route_pair` rule: exactly two toponym-shaped tokens with nothing between them.
 *
 * **The known confound is structural and unfixable here.** "Paris London" and "Moscow Idaho" are the same string shape
 * — two bare capitalized words — and separating them needs to know that Idaho is a region, which is a gazetteer fact,
 * not a structural one. The hard-slice board's 18 `comma_free` rows are that population, and they fire this rule. That
 * is the reason ROAD_TO_V9 §4.3 specifies **classification + a declared fork, never a router**: both readings are named
 * in the marker, neither wins, and the resolver keeps answering exactly as it did.
 *
 * The one class that IS separable structurally is the two-token SINGLE name — "New York", "Fort Worth", "San Francisco"
 * — because those carry a toponymic head particle. That guard is what keeps the fork off the common case.
 */
export function scoreRoutePair(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const words = bareNameWords(input, shape)

	if (!words || words.length !== 2) return 0

	const [first, second] = [words[0]!.toLowerCase(), words[1]!.toLowerCase()]

	// Reduplication — "Pago Pago", "Baden-Baden", "Walla Walla", "Bora Bora". Nobody travels from a place to itself,
	// so a repeated token is a universal single-name signal and needs no lexicon at all.
	if (first === second) return 0

	if (TOPONYM_HEAD_PARTICLES.has(first) || TOPONYM_HEAD_PARTICLES.has(second)) return 0

	if (TOPONYM_TAIL_NOUNS.has(second)) return 0

	return ROUTE_PAIR_CONFIDENCE
}

/**
 * `near_me` rule: a subject plus a deictic locator, with no anchor.
 *
 * Requires a non-empty subject before the locator, so a bare "near me" stays with the `landmark` leaders rule rather
 * than claiming to be a category search with a missing focus point.
 */
export function scoreNearMe(input: NormalizedInputLite, _shape: QueryShapeLike): number {
	const lowercased = input.normalized.trim().toLowerCase()

	if (!hasDeicticTail(lowercased)) return 0

	// The subject is everything before the locator. `hasDeicticTail` already anchored the match to the end, so the
	// first match index is where the subject stops.
	const match = DEICTIC_LOCATOR_TAIL.exec(lowercased) ?? DEICTIC_ADVERB_TAIL.exec(lowercased)

	if (!match) return 0

	return lowercased.slice(0, match.index).trim() ? NEAR_ME_CONFIDENCE : 0
}

/**
 * The subject of a `near_me` query — the category or thing the asker wants, with the locator stripped. Empty string
 * when the rule would not have fired. Used to build the marker's evidence, never to route.
 */
export function nearMeSubject(input: NormalizedInputLite): string {
	const trimmed = input.normalized.trim()
	const lowercased = trimmed.toLowerCase()
	const match = DEICTIC_LOCATOR_TAIL.exec(lowercased) ?? DEICTIC_ADVERB_TAIL.exec(lowercased)

	if (!match) return ""

	return trimmed.slice(0, match.index).trim()
}
