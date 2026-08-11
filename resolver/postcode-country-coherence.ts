/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode-country coherence (#42) — the joint-consistency resolve keyed on the (postcode, locality)
 *   PAIR, and the first mechanism in the tree allowed to override `defaultCountry`.
 *
 *   The failing case: `12 Rue de Rivoli, 75001 Paris` under the en-US locale. `--locale` defaults to
 *   `en-US`, `localeToCountry` turns that into `ResolveOpts.defaultCountry = "US"`, and the backend
 *   turns THAT into a hard `spr.country = 'US'` WHERE clause. The candidate pool is all-US before
 *   ranking begins, so a coarse placer that already called this address FR at confidence
 *   0.9999908844 has nothing to promote — a soft re-rank downstream of a hard filter is inert by
 *   construction. Population then picks Paris, Texas (pop 24,969). With the postal shards attached
 *   the answer gets WORSE, not merely wrong: the postcode resolves to the US row (ZIP 75001,
 *   Addison TX), `applyPostcodeConsistency` finds no Paris within its 50 km gate (the nearest is
 *   143.8 km), and falls the locality coordinate back to the ZIP point. See
 *   `docs/records/evals/2026-08-03-postcode-locality-scoping.md` for the instrumented diagnosis.
 *
 *   No pattern-only lever can fix this. `75001` is NOT unambiguously French:
 *   `candidateSystemsForPostcode("75001")` returns `["us", "de", "fr"]`, and the 2026-08-04
 *   candidate gazetteer holds the literal string in FOUR countries — FR 48.863,2.336 (Paris 1er),
 *   US 32.960,-96.838 (Addison TX), DE 48.844,9.367, PL 54.190,16.188 (×2 rows). The SHAPE is
 *   ambiguous four ways. The GEOMETRY is not: Addison and Paris are ~8,000 km apart, and only one
 *   of the four has a same-named locality next to its 75001.
 *
 *   So this pass asks the question the shape cannot answer — _in which country are this postcode and
 *   this locality geographically consistent?_ — over exactly the primitive the resolver already uses
 *   three times (`applyAdminCoherence` #263, `applyExplicitCountryCoherence` #822,
 *   `applyRegionCountryCoherence`), just keyed on the postcode instead of a region or country token.
 *
 *   ## Why it runs BEFORE the walk, not after
 *
 *   Its three siblings are post-walk re-picks: the walk resolves greedily, they swap the wrong node
 *   pair for the right one. That shape cannot work here, because the thing to correct is the walk's
 *   COUNTRY SCOPE, and the scope poisons three separate things a post-walk pass cannot reach — the
 *   postcode node's own resolution (Addison, not Paris 1er), the `applyPostcodeConsistency` fallback
 *   that then drags the locality onto it, and the `country` filter on every other admin lookup. So
 *   this pass is a pre-walk SCOPE decision: it runs once, before the first lookup, and replaces
 *   `state.defaultCountry` for the whole walk. Everything downstream — including the three post-walk
 *   coherence passes and the street/rooftop tiers — then sees the corrected country.
 *
 *   ## Why it is not a hard veto (the doctrine gate)
 *
 *   Registries are SOFT priors here, positive evidence only. Two properties keep this one honest:
 *
 *   1. **The default country is tested FIRST, and a coherent default always wins.** If (postcode,
 *      locality) is consistent under `defaultCountry`, the pass returns `null` immediately, having
 *      spent at most two lookups, and the walk is byte-identical. Every correctly-scoped domestic
 *      parse exits here. It is not "US loses to FR"; it is "US had no answer".
 *   2. **Abstention is the default outcome.** Zero coherent countries (a wrong-for-the-city
 *      postcode, or a recall gap in the gazetteer) and MORE than one coherent country (a genuine
 *      geographic tie) both return `null`. The mechanism only ever speaks when exactly one country
 *      makes the pair consistent, and only ever when the default country could not.
 *
 *   ## What #24 changed (2026-08-10)
 *
 *   Two structural gaps, both found by replaying the 420-row panel-v2 benchmark. The pass is default-ON,
 *   the eu-mixed block gave it 29 chances, and it fired **zero** times — while the right answer sat in
 *   the shipped gazetteer within 4 km of truth on 21 of them.
 *
 *   1. **The candidate countries came from a proxy.** `candidateSystemsForPostcode` is a shape test over
 *      the eight slices codex specifies (`us de fr ca gb jp au nz`), so CZ, CH, BE, DK, AT, NL and IT
 *      could never be PROPOSED, however good the evidence. `13000` shapes as `[us, de, fr]`; the
 *      gazetteer holds it in exactly one country, and that country is CZ. The candidate set now unions
 *      the shape list with the countries the gazetteer actually holds the postcode in — one unscoped
 *      lookup, exhaustive at the measured cardinality (the most-shared code in the artifact carries 12
 *      rows across 8 countries). Every candidate still has to pass the same geometric pair test, so the
 *      widening can only convert an abstention into a verdict or a verdict into an abstention, never a
 *      verdict into a different one.
 *   2. **The pair was all-or-nothing.** Ten panel rows had unimpeachable one-sided evidence and no pair:
 *      the gazetteer carries no CH or BE postcodes at all (so `Sarnen` and `Kelmis` could never agree
 *      with anything), and `Praha 3` / `Praha 9` are municipal districts no admin gazetteer names (so
 *      `13000` had nothing to agree WITH). Each half may now speak alone — but only when the DEFAULT
 *      country corroborates NEITHER half, and only when the speaking half names exactly one country in
 *      the whole gazetteer. See {@link PostcodeCountryScopeEvidence}.
 *
 *   The abstention doctrine is unchanged and is what bounds the new rungs: a two-country tie is a HARD
 *   abstention that never falls through to the single-sided rungs, and any corroboration at home — the
 *   address's own city or its own postcode existing in the default country — stops the pass dead.
 *
 *   ## Evidence
 *
 *   Prototyped out-of-tree against the live gazetteer over the public `findPlace` surface (2026-08-03):
 *   400 real US (ZIP, city) pairs from `postalcode-us.db` + 400 real FR (CP, commune) pairs from
 *   `postcode-locality-fr.db` — 800 pairs, **zero** border crossings, at both the 15 km and 25 km
 *   gates. The 22 US abstentions were pairs whose ZIP parent name is not an exact-matching locality
 *   in the admin gazetteer (a recall gap; abstention is the safe outcome). The confound board's
 *   verdicts were identical at 15, 25 AND 50 km, so the mechanism is not gate-tuned; the default
 *   below is the 25 km the scale run measured.
 *
 *   Cost: 2 lookups on the byte-stable path (postcode + locality under the default country), and at
 *   most `2 × |candidateSystems|` — bounded at 8, since a numeric shape matches at most `us`/`de`/`fr`
 *   — when the default is incoherent. Nothing runs at all unless a `defaultCountry` is in force AND
 *   the tree carries both a postcode and a locality.
 *
 *   **Default-ON** since the operator promotion of 2026-08-05 (#1477) — the resolver gauntlet, pinned
 *   both ways, returned zero newly-failing gated cases, and 56,000 pair evaluations across both
 *   backends returned zero false positives. `ResolveOpts.postcodeCountryCoherence: false` opts out,
 *   and the walk is byte-stable then. Receipts:
 *   `docs/records/evals/2026-08-05-postcode-coherence-default-on-evidence.md`.
 */

// `postcode-systems` has no dedicated export subpath; the barrel is where every other consumer
// (`neural/postcode-anchor.ts`) reaches it from.
import { candidateSystemsForPostcode } from "@mailwoman/codex"
import type { AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"

/**
 * Default gate radius (km) for the postcode↔locality consistency test. 25 km is what the 800-pair scale run measured;
 * the confound board returned identical verdicts at 15, 25 and 50, so this is a floor choice, not a tuned one.
 */
export const POSTCODE_COUNTRY_COHERENCE_GATE_KM = 25

/**
 * Which half (or halves) of the address bought the verdict — the firing receipt, so a reader of a scoped result can
 * tell a two-sided agreement from a one-sided uniqueness claim without re-deriving it.
 *
 * - `pair` — postcode AND locality both resolve in this country, within the gate. The strongest rung and the only one
 *   that existed before #24.
 * - `locality` — the locality names exactly one country in the whole gazetteer, and the postcode names none that
 *   contradict it. This is the CH/BE class: the gazetteer carries no Swiss or Belgian postcodes at all, so the pair
 *   test can never fire there no matter how good the locality evidence is.
 * - `postcode` — the postcode is held in exactly one country and the locality is in no gazetteer at all. The `Praha 3`
 *   class: a municipal district nobody's admin gazetteer names.
 */
export type PostcodeCountryScopeEvidence = "pair" | "locality" | "postcode"

/**
 * A country in which the address's own evidence is geographically consistent.
 */
export interface PostcodeCountryScope {
	/**
	 * ISO-3166 alpha-2, upper-case.
	 */
	country: string
	/**
	 * The postcode string the verdict was reached on (as it appears in the tree).
	 */
	postcode: string
	/**
	 * The locality string the verdict was reached on.
	 */
	locality: string
	/**
	 * Which evidence carried the verdict. See {@link PostcodeCountryScopeEvidence}.
	 */
	evidence: PostcodeCountryScopeEvidence
	/**
	 * Distance between the resolved postcode point and the nearest same-named locality, in km. Always `<= gateKm`.
	 * Present ONLY for the `pair` rung — a single-sided verdict has no two points to measure between, and reporting a `0`
	 * there would assert an agreement nobody tested (the meaning-of-zero rule).
	 */
	distanceKm?: number
	/**
	 * The postcode place that anchored the verdict. Absent on the `locality` rung.
	 */
	postcodePlace?: ResolvedPlace
	/**
	 * The locality place that anchored the verdict. Absent on the `postcode` rung.
	 */
	localityPlace?: ResolvedPlace
}

export interface PostcodeCountryScopeOpts {
	/**
	 * The postcode string from the tree (the resolver already pre-scans for it — pass `state.postcode` so this pass and
	 * the walk can never disagree about WHICH postcode is the address's).
	 */
	postcode: string
	/**
	 * The country the caller's `defaultCountry` would hard-filter to — or `undefined` when no default is in force (the
	 * browser cascade), where the pass CONSTRAINS instead of overriding: the default-coherence short-circuit is vacuous
	 * and the exactly-one-country abstention carries the safety alone. Historically required: this pass was built to
	 * correct a wrong one, so with no default there is nothing to correct and the caller should not be calling.
	 */
	defaultCountry: string | undefined
	/**
	 * Consistency gate radius in km. Defaults to {@link POSTCODE_COUNTRY_COHERENCE_GATE_KM}.
	 */
	gateKm?: number
	/**
	 * Optional narrowing of the SHAPE half of the candidate-country set — the shape-coherence pass's intersection for a
	 * CONFIRMED postcode span (see `resolver/postcode-shape-coherence.ts`, #31 Mechanism 1). When present it REPLACES
	 * `candidateSystemsForPostcode`'s own list; it is a pure subset of that list (codex systems ∩ confident sibling
	 * systems). Upper-case ISO-3166 alpha-2, e.g. `["US"]` for a 5-digit code whose siblings all say US.
	 *
	 * It narrows the shape half only. Since #24 the candidate set also carries the countries the GAZETTEER holds this
	 * postcode in, and that half is not narrowable — it is the artifact reporting what it contains, which is the same
	 * class of evidence the pair test itself runs on. Every candidate from either half still has to pass that test.
	 */
	candidateSystems?: readonly string[]
}

/**
 * A usable coordinate — the gazetteer stores an unlocated row as 0,0, which haversine would happily measure against.
 */
function hasCoord(p: ResolvedPlace): boolean {
	return p.lat !== 0 || p.lon !== 0
}

/**
 * The address's locality string: the first `locality` node anywhere in the tree, else the first `dependent_locality`.
 * Two passes so a real locality always beats a dependent one regardless of tree order.
 */
export function firstLocalityValue(roots: readonly AddressNode[]): string | undefined {
	for (const tag of ["locality", "dependent_locality"] as const) {
		const stack = [...roots]

		while (stack.length) {
			const n = stack.pop()!

			if (n.tag === tag && n.value.trim().length) return n.value.trim()

			stack.push(...n.children)
		}
	}

	return undefined
}

/**
 * Over-fetch for the UNSCOPED holder probes (#24). Postcodes are bounded and small — the 2026-08-10 candidate
 * gazetteer's most-shared code carries 12 rows across 8 countries — so 20 sees every bearer and the postcode holder set
 * is COMPLETE, not a sample. Locality names are not bounded that way (`rampur` has 1,096 rows, `bara` spans 42
 * countries), so 30 is a population-first WINDOW: it can only ever hide a country, which turns a "more than one
 * country" abstention into a false "exactly one". The explicit default-country probe below is what closes that gap for
 * the case that matters (the address is domestic after all).
 */
const POSTCODE_HOLDER_FETCH = 20
const LOCALITY_HOLDER_FETCH = 30

/**
 * Upper bound on countries the pair rung will test, so a pathological name can't turn one incoherent parse into a
 * hundred lookups. The postcode holder set is ≤8 countries in the measured artifact and the codex shape list is ≤8, so
 * this only ever binds on a gazetteer very unlike today's.
 */
const MAX_CANDIDATE_COUNTRIES = 12

/**
 * Countries that hold an exact, coordinate-bearing row for `text` at `placetype`, mapped to their best (first) such
 * row. One UNSCOPED lookup.
 *
 * This is the #24 candidate source, and it replaces a proxy with the thing itself. The pass used to ask codex "which
 * address SYSTEMS could this shape be?" — a model-free shape test over the eight slices codex specifies. That answer is
 * correct and useless for two thirds of Europe: `13000` shapes as `[us, de, fr]`, the gazetteer holds it in exactly one
 * country (CZ), and CZ has no codex slice, so the pass could not propose the only country that could possibly be right.
 * Membership in the gazetteer is positive evidence of the same kind the pair test already runs on, available for one
 * lookup, and it is EXHAUSTIVE for postcodes at the measured cardinality.
 *
 * `exactMatch !== false` is the admission bar: a fuzzy postcode hit is a DIFFERENT postcode (the 2026-08-05 Code-Point
 * lesson — `BT3 9QQ` trigram-matching Sheffield's `S3 9QQ`), and a fuzzy locality hit is evidence about the index, not
 * about the country. Backends that do not stamp the flag leave it undefined and still contribute.
 */
async function countriesHolding(
	backend: ResolverBackend,
	text: string,
	placetype: "postalcode" | "locality",
	limit: number
): Promise<Map<string, ResolvedPlace>> {
	const out = new Map<string, ResolvedPlace>()

	let hits: ResolvedPlace[]

	try {
		hits = await backend.findPlace({ text, placetype, limit })
	} catch {
		return out // a backend hiccup degrades to "no evidence", never to a crashed resolve
	}

	for (const hit of hits) {
		const country = hit.country?.trim().toUpperCase()

		if (!country || hit.exactMatch === false || !hasCoord(hit)) continue

		if (!out.has(country)) {
			out.set(country, hit)
		}
	}

	return out
}

/**
 * Is the (postcode, locality) pair geographically consistent in `country`? Returns the winning pair and its distance,
 * or `null` when the postcode does not resolve there, no same-named locality exists there, or the nearest one is
 * outside the gate. Costs one postcode lookup plus (only if that hit) one locality lookup — or just the locality lookup
 * when the caller already knows the country's postcode row (`knownPostcodePlace`, from the exhaustive unscoped probe).
 */
async function coherenceIn(
	country: string,
	postcode: string,
	locality: string,
	backend: ResolverBackend,
	gateKm: number,
	knownPostcodePlace?: ResolvedPlace
): Promise<{ postcodePlace: ResolvedPlace; localityPlace: ResolvedPlace; distanceKm: number } | null> {
	let postcodePlace = knownPostcodePlace

	if (!postcodePlace) {
		let postcodeHits: ResolvedPlace[]

		try {
			postcodeHits = await backend.findPlace({ text: postcode, placetype: "postalcode", country, limit: 3 })
		} catch {
			return null // a backend hiccup degrades to "no evidence here", never to a crashed resolve
		}

		postcodePlace = postcodeHits.find(hasCoord)
	}

	if (!postcodePlace) return null

	let localityHits: ResolvedPlace[]

	try {
		localityHits = await backend.findPlace({ text: locality, placetype: "locality", country, limit: 5 })
	} catch {
		return null
	}

	// EXACT matches only. A fuzzy same-country hit ("Paris" → "Parish") is not evidence that the postcode
	// belongs to this country; it is evidence that the FTS index is generous. Backends that do not stamp
	// `exactMatch` therefore contribute nothing here rather than contributing noise.
	let best: { localityPlace: ResolvedPlace; distanceKm: number } | null = null

	for (const candidate of localityHits) {
		if (!candidate.exactMatch || !hasCoord(candidate)) continue
		const distanceKm = haversineKm(postcodePlace.lat, postcodePlace.lon, candidate.lat, candidate.lon)

		if (distanceKm > gateKm) continue

		if (!best || distanceKm < best.distanceKm) {
			best = { localityPlace: candidate, distanceKm }
		}
	}

	return best ? { postcodePlace, ...best } : null
}

/**
 * The country in which this address's postcode and locality are geographically consistent — or `null` to abstain.
 *
 * Order matters and is the whole safety argument. The caller's `defaultCountry` is tested FIRST; a coherent default
 * short-circuits with `null` (nothing to correct, ≤2 lookups spent, the walk unchanged). Only when the default cannot
 * make the pair consistent are the codex shape's other candidate systems tried, and only a UNIQUE coherent alternative
 * produces a verdict — zero (no evidence) and two-or-more (a genuine tie) both abstain.
 *
 * The candidate set is `candidateSystemsForPostcode` — a model-free SHAPE test over each codex slice's own postcode
 * pattern, no safelist and no prior. Its `SystemCode` values are ISO-3166 alpha-2 in lower case, so the upper-casing
 * below is the whole conversion. Note the corollary: a country with no codex slice can never be proposed (the gazetteer
 * holds `75001` in PL, and this pass will never return PL), which bounds the mechanism to the systems whose postcode
 * shapes are actually specified.
 */
export async function findPostcodeCountryScope(
	roots: readonly AddressNode[],
	backend: ResolverBackend,
	opts: PostcodeCountryScopeOpts
): Promise<PostcodeCountryScope | null> {
	const postcode = opts.postcode.trim()
	const defaultCountry = opts.defaultCountry?.trim().toUpperCase() || undefined

	if (!postcode) return null

	const locality = firstLocalityValue(roots)

	// Both halves of the pair are required. A postcode with no locality has nothing to be coherent WITH, which is what
	// keeps this pass inert on "Springfield, IL 62701" (the parser tags Springfield as a `street` — a separate defect)
	// and on every bare-postcode query.
	if (!locality) return null

	const gateKm = opts.gateKm ?? POSTCODE_COUNTRY_COHERENCE_GATE_KM

	// 1. Is the caller's own default country coherent? If so we are done — positive evidence for the default,
	//    no override, and the common domestic path costs two lookups and changes nothing. With no default in
	//    force (the browser cascade) there is nothing to test — the sweep below carries the whole verdict.
	if (defaultCountry && (await coherenceIn(defaultCountry, postcode, locality, backend, gateKm))) return null

	// 2. The default could not place this pair. Which countries could? Two sources, unioned:
	//
	//    - the SHAPE list (`candidateSystemsForPostcode`, or the shape-coherence pass's narrowing when #31
	//      Mechanism 1 supplied one — a pure subset of it), and
	//    - the countries the GAZETTEER actually holds this postcode in (#24). Exhaustive at the measured
	//      cardinality, and the only source that can name a country codex has no slice for — which was the
	//      whole reason the CZ/CH/BE/DK/AT/NL block of the 2026-08-09 panel resolved to US namesakes while
	//      their own postcodes sat in the shipped gazetteer within 4 km of truth.
	//
	//    The union can only ADD countries, and every added one must still pass the same geometric pair test,
	//    so this widens recall without weakening the verdict: a second coherent country turns a verdict into
	//    an abstention (safe), never into a wrong answer.
	const pcHolders = await countriesHolding(backend, postcode, "postalcode", POSTCODE_HOLDER_FETCH)

	const shapeSystems = (
		opts.candidateSystems ?? candidateSystemsForPostcode(postcode).map((system) => system.toUpperCase())
	).map((country) => country.trim().toUpperCase())

	const candidates = [...new Set([...shapeSystems, ...pcHolders.keys()])]
		.filter((country) => country !== defaultCountry)
		.slice(0, MAX_CANDIDATE_COUNTRIES)

	const coherent: PostcodeCountryScope[] = []

	for (const country of candidates) {
		const hit = await coherenceIn(country, postcode, locality, backend, gateKm, pcHolders.get(country))

		if (hit) {
			coherent.push({ country, postcode, locality, evidence: "pair", ...hit })
		}
	}

	// 3. Exactly one country makes the pair consistent, or we fall through. Two coherent countries mean the geometry
	//    genuinely does not decide, and guessing between them is precisely what this mechanism exists not to do — so a
	//    TIE is a hard abstention, never a fall-through to the weaker rungs below.
	if (coherent.length === 1) return coherent[0]!

	if (coherent.length > 1) return null

	// The single-sided rungs below lean on the DEFAULT country as the domestic-plausibility guard
	// ("Vienna, VA" stays in Virginia because the default corroborates a half). With no default there
	// is no such anchor, so the no-default path ends at the pair rung: a pair verdict (Zabiče) is
	// in-scope, a single-sided guess is not.
	if (!defaultCountry) return null

	// 4. No country makes the PAIR consistent. On the 2026-08-09 panel that happened 10 times for two opposite
	//    reasons, and in both the address's country was never in doubt — only unrepresentable as a pair:
	//
	//      - the gazetteer holds no postcodes for the country at all (CH, BE), so the postcode half can never
	//        agree with anything no matter how good the locality evidence is; or
	//      - the locality is a name no admin gazetteer carries (`Praha 3`, `Praha 9` — municipal districts).
	//
	//    So each half gets to speak alone, under two conditions that keep this from becoming a guess. First, the
	//    DEFAULT country must corroborate NEITHER half — if the address's own city or its own postcode exists at
	//    home, the address is domestically plausible and nothing foreign may be proposed (this is what holds
	//    `123 Main St, Vienna, VA 22180` in Virginia even though Wien is the vastly more prominent Vienna).
	//    Second, the speaking half must name EXACTLY ONE country in the entire gazetteer — the same uniqueness bar
	//    the pair rung uses, applied to one side.
	if (pcHolders.has(defaultCountry)) return null

	if (await holdsLocality(backend, locality, defaultCountry)) return null

	// 4a. The locality names exactly one country. Stronger than the postcode rung — a place name is far more
	//     discriminative than a four-digit code — so it is tried first. It stands down when that country's OWN
	//     postcode row contradicts the locality (outside the gate): the two halves disagreeing inside one country
	//     is exactly what the pair test exists to catch, and a single-sided rung must not launder it.
	const locHolders = await countriesHolding(backend, locality, "locality", LOCALITY_HOLDER_FETCH)

	if (locHolders.size === 1) {
		const [country, localityPlace] = [...locHolders.entries()][0]!
		const ownPostcode = pcHolders.get(country)

		const contradicted =
			ownPostcode !== undefined &&
			haversineKm(ownPostcode.lat, ownPostcode.lon, localityPlace.lat, localityPlace.lon) > gateKm

		if (country !== defaultCountry && !contradicted) {
			return { country, postcode, locality, evidence: "locality", localityPlace }
		}
	}

	// 4b. The locality is in no gazetteer (or names several countries) and the postcode is held in exactly one.
	//     `Biskupcova 1843/3, 13000 Praha 3`: `13000` is a CZ code and nothing else, anywhere.
	if (!locHolders.size && pcHolders.size === 1) {
		const [country, postcodePlace] = [...pcHolders.entries()][0]!

		if (country !== defaultCountry) {
			return { country, postcode, locality, evidence: "postcode", postcodePlace }
		}
	}

	return null
}

/**
 * Does `country` hold an exact, coordinate-bearing locality row for `locality`? One scoped lookup — deliberately NOT
 * read off the unscoped holder window, which is population-first and truncated, so a small domestic bearer could fall
 * below its fold and let a foreign scope through.
 */
async function holdsLocality(backend: ResolverBackend, locality: string, country: string): Promise<boolean> {
	try {
		const hits = await backend.findPlace({ text: locality, placetype: "locality", country, limit: 3 })

		return hits.some((hit) => hit.exactMatch && hasCoord(hit))
	} catch {
		// A backend hiccup must not be read as "the default country has nothing" — that would license a foreign
		// scope on no evidence. Treat it as corroboration and abstain.
		return true
	}
}

/**
 * Stamp the adopted scope onto the tree's postcode and locality nodes, so a consumer can see that the walk's country
 * was not the one the caller asked for — and which evidence bought the change. Additive: identity and coordinates are
 * untouched, this only writes `metadata`.
 */
export function stampPostcodeCountryScope(roots: readonly AddressNode[], scope: PostcodeCountryScope): void {
	const stack: AddressNode[] = [...roots]

	while (stack.length) {
		const n = stack.pop()!

		stack.push(...n.children)

		if (n.tag !== "postcode" && n.tag !== "locality" && n.tag !== "dependent_locality") continue

		n.metadata = {
			...n.metadata,
			postcode_country_scope: scope.country,
			// WHICH rung spoke — a two-sided agreement and a one-sided uniqueness claim are different evidence,
			// and a consumer that cannot tell them apart cannot weight them differently.
			postcode_country_scope_evidence: scope.evidence,
			// Only the `pair` rung measured a distance. Writing a 0 for the single-sided rungs would assert an
			// agreement nobody tested.
			...(scope.distanceKm !== undefined ? { postcode_country_scope_km: scope.distanceKm } : {}),
		}
	}
}
