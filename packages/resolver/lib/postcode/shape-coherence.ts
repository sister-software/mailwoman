/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode-shape coherence (#31, Mechanism 1) — shape as CONFIDENCE and EXCLUSION, downstream of the
 *   siblings. The fifth member of the joint-consistency coherence family (after `applyAdminCoherence`
 *   #263, `applyExplicitCountryCoherence` #822, `applyRegionCountryCoherence`, and
 *   `findPostcodeCountryScope` #42/#1477), and the only one that is pure-sync and backend-free:
 *   everything it needs is `candidateSystemsForPostcode` plus the tree.
 *
 *   The defect (M-1, `docs/superpowers/plans/2026-08-05-postcode-structure-arc.md`): the decoder
 *   sometimes tags a HOUSE NUMBER as `postcode` when its digits form a foreign postcode shape —
 *   "1200" in "Twin Peaks Golf Course, 1200 Cornell Dr, Longmont, CO 80503" is accepted only by the
 *   AU/NZ 4-digit shape, while every sibling placetype says US. The shape alone cannot say a code is
 *   foreign (49/100 Gauntlet codes are accepted by more than one system, 10 by none), so this pass
 *   never reads the shape as country evidence by itself — it INTERSECTS each span's candidate systems
 *   with the systems the SIBLINGS already assert, and only a confident sibling set can demote.
 *
 *   ## The rule (three outcomes, per span)
 *
 *   1. **Intersection non-empty → CONFIRMED.** Stamp `postcode_shape_systems` (the narrowed
 *      intersection, upper-case). Additive metadata only — resolution is byte-identical (B1-1). The
 *      same intersection narrows `findPostcodeCountryScope`'s candidate list when the caller threads
 *      it (a pure subset of codex's shape candidates — safe by construction).
 *   2. **Intersection empty + confident siblings → EXCLUDED.** A digit-only span is demoted to
 *      `house_number` (the correct sibling tag — B1-2's "correct sibling tag surviving"); a
 *      letter-bearing span keeps its tag and gets `postcode_shape_excluded: true` instead (the
 *      compound-split corner — "15 07691" — is #942 postal-compound-recovery territory, out of
 *      scope). Either way the span's contribution to the resolve is stripped: `firstPostcodeValue`,
 *      the walk's postcode lookup, and the post-walk postcode passes all skip excluded spans.
 *   3. **No confident siblings → ABSTAIN** (the `postcode-country-coherence.ts:269` posture
 *      verbatim). A shape no codex system recognizes (the 10/110 slice-less codes) also abstains —
 *      an empty candidate set is no evidence either way.
 *
 *   ## What counts as a sibling signal
 *
 *   - The **country node**, via `matchCountry`, territory-mapped: PR/VI/GU/MP/AS are USPS
 *     abbreviations (`codex/us/state.ts`), so a "Puerto Rico" token speaks for `us` — the mapping
 *     that protects the true postcode in "Ponce, 00716, Puerto Rico".
 *   - The **region node**, via `matchSubdivision` (US states + CA provinces; the US-first tiebreak
 *     that makes "CA" mean California is `matchSubdivision`'s own), plus the region's
 *     `country_hint` metadata stamp (`mailwoman/region-recognition.ts` writes it on 2-letter US
 *     state abbreviations).
 *   - Signals are filtered to the codex SystemCode universe BEFORE the intersection test. A country
 *     with no codex slice (ES, MX, IE, …) can never appear in any candidate set, so an unfiltered
 *     signal would make every intersection empty and every span "foreign" — the slice-less filter
 *     is the whole reason the JP-shaped "15 07691" span in the ES Portopetro row ABSTAINS rather
 *     than false-excludes.
 *
 *   Deliberately NOT a signal: a second postcode span. The census's "cross-span" idea fails on the
 *   symmetric case — "2000 Sydney NSW, SW1A 2AA London" would exclude BOTH true codes (their systems
 *   are disjoint), a regression worse than the defect. Cross-country multi-postcode strings are
 *   pathological, and every M-1 span carries a country/region/`country_hint` signal instead.
 *
 *   `defaultCountry` is never a signal: it is a LOCALE DEFAULT, not knowledge. B1-3's confound —
 *   "Sydney NSW 2000, Australia" reached with a US default must not have its 2000 excluded, and "10
 *   Downing Street, London SW1A 2AA" under a US default must not either. Those rows are exactly what
 *   `findPostcodeCountryScope` exists to rescue, and an exclusion pass that trusted the default
 *   would delete the evidence the country pass needs.
 *
 *   ## Evidence posture
 *
 *   M-1's six Gauntlet exclusion spans grade 4 exclusions (US "1600"/"3080"/"1200" via their region,
 *   PR "3499" via the territory-mapped country) + 2 documented abstentions (MX "2000" — no country
 *   token, "Tabasco" is not a `matchSubdivision` key; ES "15 07691" — no ES slice). Within-country,
 *   the exclusion problem is close to empty on the curated board, and a 5-digit house number in a
 *   DE/FR address is shape-native — the shape cannot exclude it (M-1 finding #1), so the mechanism
 *   CONFIRMS it instead.
 *
 *   **D-rule: opt-in behind `ResolveOpts.postcodeShapeCoherence`, default-OFF.** Demotion is the
 *   failure mode with teeth, so a default-on promotion needs the full pre-registered eval (B1-1
 *   byte-stability, B1-2 exclusion ≥90% with the correct sibling tag surviving, B1-3 confound ≤2%
 *   false exclusions; kill on any B1-3 δ).
 */

import { candidateSystemsForPostcode } from "@mailwoman/codex"
import { matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import { isUSStateAbbreviation } from "@mailwoman/codex/us"
import type { AddressNode } from "@mailwoman/core/decoder"

/**
 * The codex address systems a sibling signal can speak for — the universe `candidateSystemsForPostcode` can return, in
 * the upper-case ISO form this module's signals are emitted in (`SystemCode` itself is lower-case). Signals from
 * countries with no codex slice are filtered out BEFORE the intersection test, so a slice-less country can never
 * manufacture an empty intersection (the false-exclusion trap; see the header).
 */
const SYSTEM_UNIVERSE: ReadonlySet<string> = new Set<string>(["US", "DE", "FR", "CA", "GB", "JP", "AU", "NZ"])

/**
 * The pass's per-tree verdict — the caller (and the B1 board tests) can see exactly which spans were confirmed,
 * excluded, or abstained, and which confirmed span's narrowed systems should bound the country-scope pass.
 */
export interface PostcodeShapeVerdict {
	/**
	 * The narrowed candidate systems (upper-case) of the FIRST confirmed postcode node — the one `firstPostcodeValue`
	 * will pick — to thread into `findPostcodeCountryScope` as its candidate list. Undefined when no postcode node was
	 * confirmed.
	 */
	narrowing?: string[]
	/**
	 * The postcode strings the mechanism confirmed (shape ∩ confident siblings ≠ ∅).
	 */
	confirmed: string[]
	/**
	 * The postcode strings the mechanism excluded (shape ∩ confident siblings = ∅).
	 */
	excluded: string[]
	/**
	 * The postcode strings the mechanism abstained on (no confident siblings, or no codex shape).
	 */
	abstained: string[]
}

/**
 * Collect the sibling country signals: the country node (territory-mapped), the region node (`matchSubdivision` +
 * `country_hint`), each filtered to the codex SystemCode universe. The tree is walked once for ALL postcode spans —
 * sibling evidence is tree-level, not per-span.
 */
function collectSiblingSystems(roots: readonly AddressNode[]): Set<string> {
	const out = new Set<string>()
	const stack: AddressNode[] = [...roots]

	while (stack.length) {
		const n = stack.pop()!
		stack.push(...n.children)

		if (n.tag === "country") {
			const matched = matchCountry(n.value)

			if (!matched) continue
			// Territory map: PR/VI/GU/MP/AS are USPS state-or-territory abbreviations (codex/us/state.ts),
			// so a US-territory country token ("Puerto Rico", "Guam") is a US-system signal.
			const system = isUSStateAbbreviation(matched.iso2) ? "US" : matched.iso2.toUpperCase()

			if (SYSTEM_UNIVERSE.has(system)) {
				out.add(system)
			}

			continue
		}

		if (n.tag === "region") {
			// (a) The region's value as a subdivision ("CA" → US, "ON" → CA — the US-wins tiebreak for
			// "CA" is matchSubdivision's own). (b) The `country_hint` stamp annotateUSRegions writes on
			// 2-letter US state abbreviations — the same evidence via the pipeline's other path.
			const sub = matchSubdivision(n.value)

			if (sub && SYSTEM_UNIVERSE.has(sub.country.toUpperCase())) {
				out.add(sub.country.toUpperCase())
			}

			const hint = n.metadata?.["country_hint"]

			if (typeof hint === "string" && SYSTEM_UNIVERSE.has(hint.toUpperCase())) {
				out.add(hint.toUpperCase())
			}
		}
	}

	return out
}

/**
 * Run the shape-coherence verdict over every `postcode` span in the tree, mutating the EXCLUDED spans in place (the
 * retag / exclusion stamp) and stamping CONFIRMED spans' narrowed systems. Pure-sync: no backend, no queries. See the
 * header for the full rule.
 */
export function applyPostcodeShapeCoherence(roots: readonly AddressNode[]): PostcodeShapeVerdict {
	const verdict: PostcodeShapeVerdict = { confirmed: [], excluded: [], abstained: [] }

	// The postcode spans in tree order — the same DFS `firstPostcodeValue` uses, so the verdict's
	// "first confirmed" is the node `state.postcode` will read.
	const postcodes: AddressNode[] = []
	const stack: AddressNode[] = [...roots]

	while (stack.length) {
		const n = stack.pop()!

		if (n.tag === "postcode" && n.value.trim().length) {
			postcodes.push(n)
		}

		stack.push(...n.children)
	}

	if (!postcodes.length) return verdict

	const siblingSystems = collectSiblingSystems(roots)

	for (const node of postcodes) {
		const code = node.value.trim()
		const systems = candidateSystemsForPostcode(code)

		// A shape no codex system recognizes is no evidence either way — abstain (the 10/110
		// slice-less Gauntlet codes: IE Eircode, SI, IM, …).
		if (!systems.length) {
			verdict.abstained.push(code)

			continue
		}

		const intersection = systems.map((system) => system.toUpperCase()).filter((system) => siblingSystems.has(system))

		if (intersection.length) {
			verdict.confirmed.push(code)
			// Additive only — resolution stays byte-identical (B1-1). The narrowed intersection is the
			// candidate set the country-scope pass should bound itself to.
			node.metadata = { ...node.metadata, postcode_shape_systems: intersection }

			if (verdict.narrowing === undefined) {
				verdict.narrowing = intersection
			}

			continue
		}

		if (siblingSystems.size) {
			// Confident siblings, empty intersection → EXCLUDED. A digit-only span is demoted to its
			// correct sibling tag (B1-2); a letter-bearing span (the "15 07691" compound corner) keeps
			// its tag and is stamped instead — either way every resolve consumer skips it.
			verdict.excluded.push(code)

			if (/^\d+$/.test(code)) {
				node.tag = "house_number"
			} else {
				node.metadata = { ...node.metadata, postcode_shape_excluded: true }
			}

			continue
		}

		// No confident siblings — the same abstention posture postcode-country-coherence.ts:269 takes
		// on zero-or-two coherent countries. Never guess with the shape alone.
		verdict.abstained.push(code)
	}

	return verdict
}

/**
 * True when a node is a postcode span this pass excluded but could not retag (the letter-bearing compound corner). The
 * resolve's postcode consumers (`firstPostcodeValue`, the walk's postcode lookup, the post-walk postcode passes) all
 * skip these, which is what "strip the postcode tag's contribution" means for a span that keeps its tag.
 */
export function isShapeExcludedPostcode(node: AddressNode): boolean {
	return node.tag === "postcode" && node.metadata?.["postcode_shape_excluded"] === true
}
