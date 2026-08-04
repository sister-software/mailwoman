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
 *   Opt-in via `ResolveOpts.postcodeCountryCoherence` (D-rule: default-off until the resolver
 *   gauntlet says otherwise).
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
 * A country in which the address's (postcode, locality) pair is geographically consistent.
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
	 * Distance between the resolved postcode point and the nearest same-named locality, in km. Always `<= gateKm`.
	 */
	distanceKm: number
	/**
	 * The postcode place that anchored the verdict.
	 */
	postcodePlace: ResolvedPlace
	/**
	 * The locality place that anchored the verdict.
	 */
	localityPlace: ResolvedPlace
}

export interface PostcodeCountryScopeOpts {
	/**
	 * The postcode string from the tree (the resolver already pre-scans for it — pass `state.postcode` so this pass and
	 * the walk can never disagree about WHICH postcode is the address's).
	 */
	postcode: string
	/**
	 * The country the caller's `defaultCountry` would hard-filter to. Required: this pass exists to correct a wrong one,
	 * so with no default there is nothing to correct and the caller should not be calling.
	 */
	defaultCountry: string
	/**
	 * Consistency gate radius in km. Defaults to {@link POSTCODE_COUNTRY_COHERENCE_GATE_KM}.
	 */
	gateKm?: number
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
 * Is the (postcode, locality) pair geographically consistent in `country`? Returns the winning pair and its distance,
 * or `null` when the postcode does not resolve there, no same-named locality exists there, or the nearest one is
 * outside the gate. Costs one postcode lookup plus (only if that hit) one locality lookup.
 */
async function coherenceIn(
	country: string,
	postcode: string,
	locality: string,
	backend: ResolverBackend,
	gateKm: number
): Promise<{ postcodePlace: ResolvedPlace; localityPlace: ResolvedPlace; distanceKm: number } | null> {
	let postcodeHits: ResolvedPlace[]

	try {
		postcodeHits = await backend.findPlace({ text: postcode, placetype: "postalcode", country, limit: 3 })
	} catch {
		return null // a backend hiccup degrades to "no evidence here", never to a crashed resolve
	}

	const postcodePlace = postcodeHits.find(hasCoord)

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
	const defaultCountry = opts.defaultCountry.trim().toUpperCase()

	if (!postcode || !defaultCountry) return null

	const locality = firstLocalityValue(roots)

	// Both halves of the pair are required. A postcode with no locality has nothing to be coherent WITH, which is what
	// keeps this pass inert on "Springfield, IL 62701" (the parser tags Springfield as a `street` — a separate defect)
	// and on every bare-postcode query.
	if (!locality) return null

	const gateKm = opts.gateKm ?? POSTCODE_COUNTRY_COHERENCE_GATE_KM

	// 1. Is the caller's own default country coherent? If so we are done — positive evidence for the default,
	//    no override, and the common domestic path costs two lookups and changes nothing.
	if (await coherenceIn(defaultCountry, postcode, locality, backend, gateKm)) return null

	// 2. The default could not place this pair. Which other country the SHAPE allows can?
	const candidates = candidateSystemsForPostcode(postcode)
		.map((system) => system.toUpperCase())
		.filter((country) => country !== defaultCountry)

	if (!candidates.length) return null

	const coherent: PostcodeCountryScope[] = []

	for (const country of candidates) {
		const hit = await coherenceIn(country, postcode, locality, backend, gateKm)

		if (hit) {
			coherent.push({ country, postcode, locality, ...hit })
		}
	}

	// 3. Exactly one country makes the pair consistent, or we abstain. Two coherent countries would mean the geometry
	//    genuinely does not decide, and guessing between them is precisely what this mechanism exists not to do.
	return coherent.length === 1 ? coherent[0]! : null
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
			postcode_country_scope_km: scope.distanceKm,
		}
	}
}
