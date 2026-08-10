/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #17 bare city-name disambiguation — two SOFT ranking keys for the bare-toponym class.
 *
 *   A bare city name is the one query shape where the resolver has no geography to reason with: no
 *   postcode to anchor against, no region to scope by, no country the address itself named. All that
 *   is left is a prior over which same-named place a person typing that word alone probably meant.
 *   The shipped prior is POPULATION, and population is measurably the wrong prior for this class —
 *   the panel run of 2026-08-10 caught it four times over:
 *
 *   | query   | population winner    | gold                  | miss     |
 *   | ------- | -------------------- | --------------------- | -------- |
 *   | Whitby  | Whitby ON (128,377)  | Whitby, N Yorks (13,130) | 5,508 km |
 *   | Warwick | Warwick RI (82,999)  | Warwick, Warks (32,719)  | 5,211 km |
 *   | Epping  | Epping VIC (32,395)  | Epping, Essex (12,547)   | 16,874 km |
 *   | Windsor | Windsor ON (217,188) | Windsor, Berks (26,885)  | 6,007 km |
 *
 *   Every one of those is a place people know for something other than its size, and the gazetteer
 *   already measures that: `admin-global-priority-importance.db` ranks all four the RIGHT way round
 *   (Whitby GB 0.5496 over CA 0.5089; Windsor GB 0.5648 over CA 0.5607 — a 0.004 margin population
 *   inverts by a factor of eight). That is the ENCYCLOPEDIC half of the ROAD_TO_V9 §2 two-score
 *   split, and until now nothing consumed it: `ResolvedPlace.encyclopedic` was carried from the
 *   backend, stamped onto node metadata, and read by no ranking key anywhere in the resolver.
 *   {@link rankByEncyclopedic} consumes it.
 *
 *   {@link rankByCountryPrior} covers the other half of the class — the query where a country IS
 *   known, but only because a locale said so. See `span-rescore.ts` for where that one applies.
 *
 *   Both obey the same three house rules, and neither is a gate:
 *
 *   1. **Tier-safe.** `exactMatch` stays the primary key. A soft prior re-orders WITHIN a tier; it never
 *      promotes a partial match over an exact one.
 *   2. **Positive evidence only.** An absent score is unmeasured, not zero (the meaning-of-zero rule), so an
 *      unscored candidate is never moved BY the signal and never penalized FOR lacking it — it keeps the
 *      rank population gave it while the scored rows reorder among themselves. On today's shipped
 *      `candidate.db` — which carries no `place_importance` at all — nothing is scored, so
 *      {@link rankByEncyclopedic} is byte-stable by construction.
 *   3. **Stable.** Equal keys keep their incoming order, so the backend's own ranking survives underneath.
 */

import type { ResolvedPlace } from "@mailwoman/core/resolver"

/**
 * Weight of the locale-country bonus, in the same log10-population units the candidate backend's `prominence` uses
 * (`-neg_rank` = log10(population + 1)). 2 == "the in-country place may be up to 100x smaller and still win".
 *
 * The value is the resolver's existing `anchorWeight` default (`resolve.ts`), reused deliberately: that knob is the
 * postcode-anchor country pin, and this is the same quantity from a weaker source, so the two should not disagree about
 * what a country signal is worth. Calibrated against the live board (2026-08-10, shipped `candidate.db`), it moves
 * exactly the queries where the locale is implausible and leaves the rest alone:
 *
 * - `Zürich` en-US — Zurich KS 1.91 + 2 = 3.91 loses to Zürich CH 5.65. **Flips** (was 8,043 km off).
 * - `Berlin` en-US — Berlin CT 4.30 + 2 = 6.30 loses to Berlin DE 6.56. **Flips.**
 * - `Manchester` en-US — Manchester NH 5.06 + 2 = 7.06 beats Manchester GB 5.74. **Held.**
 * - `Springfield` en-US — every bearer is US, so the bonus is uniform. **Held.**
 * - `Moscow` en-US — Moscow ID 4.42 + 2 = 6.42 beats Москва 6.10. **Held.**
 * - `Fulda` en-US — Fulda MN 3.13 + 2 = 5.13 beats Fulda DE 4.84. **Held.**
 */
export const DEFAULT_COUNTRY_PRIOR_WEIGHT = 2

/**
 * The fields a ranking key reads. Structural rather than `ResolvedPlace` so the backend's own `PlaceCandidate` (a
 * structural twin) can be ranked without a cast.
 */
type Rankable = Pick<ResolvedPlace, "score"> &
	Partial<Pick<ResolvedPlace, "country" | "encyclopedic" | "exactMatch" | "prominence">>

/**
 * Partition into (exact, rest), sort each half with `key` DESC, and re-join. The partition is what keeps a soft prior
 * soft: it can only ever re-order candidates the backend already considers equally good matches. Backends that don't
 * stamp `exactMatch` land every row in one tier, which is the correct degradation — the key then applies to the whole
 * list.
 */
function rankWithinTier<T extends Rankable>(candidates: readonly T[], compare: (a: T, b: T) => number): T[] {
	const exact: T[] = []
	const rest: T[] = []

	for (const c of candidates) {
		// `exactMatch` is TRI-STATE: true / false / undefined (a backend path that stamps no flag —
		// e.g. WOFSqlitePlaceLookup's postcode-area neighbours from #fetchLocalitiesByID). Only a
		// stated TRUE earns the exact tier; undefined must not outrank a real fuzzy name match
		// (the 2026-08-10 de.native_locality incident: 75 Saxon towns lost to nameless neighbours).
		;(c.exactMatch === true ? exact : rest).push(c)
	}

	// `toSorted` is stable, so equal keys keep the backend's incoming order.
	return [...exact.toSorted(compare), ...rest.toSorted(compare)]
}

/**
 * Size, in the backend's own units — the candidate backend's `prominence` is log10(population + 1); a backend that
 * computes no prominence falls back to its raw `score`.
 */
const size = (c: Rankable): number => c.prominence ?? c.score

/**
 * A candidate the gazetteer actually scored. An absent value means "no Wikipedia article" OR "this row predates the
 * split" OR "the id didn't join" — three different things, none of them zero.
 */
const measured = (c: Rankable): boolean => typeof c.encyclopedic === "number" && Number.isFinite(c.encyclopedic)

/**
 * Reorder ONLY the measured candidates, and only among the positions they already occupy.
 *
 * This is what "positive evidence only" has to mean when coverage is partial, which it always is — measured on the
 * shipped importance artifact, the four bare GB panel rows have 2/7, 8/10, 8/10 and 9/10 of their candidates scored. A
 * blanket "abstain unless everything is measured" throws the signal away on all four; treating absent as 0 would let a
 * scored hamlet leapfrog an unscored metropolis. Neither is right, and the resolution is that an unmeasured row simply
 * does not participate: it holds the rank population gave it, and the scored rows permute among the slots they hold
 * between them.
 *
 * So for `Whitby` — CA(0.5089), GB(0.5496), TC(—), then four unscored bearers — the swap is confined to slots 0 and 1,
 * GB takes the lead, and TC never moves. No threshold, no tuned band, no free parameter.
 */
function reorderMeasured<T extends Rankable>(tier: readonly T[], compare: (a: T, b: T) => number): T[] {
	const slots: number[] = []

	for (const [i, c] of tier.entries()) {
		if (measured(c)) {
			slots.push(i)
		}
	}

	if (slots.length < 2) return [...tier]
	const sorted = slots.map((i) => tier[i]!).toSorted(compare)
	const out = [...tier]

	for (const [k, slot] of slots.entries()) {
		out[slot] = sorted[k]!
	}

	return out
}

/**
 * Encyclopedic-first ordering — the two-score split's other half, consumed (ROAD_TO_V9 §2).
 *
 * Ranks by `encyclopedic` DESC within the exact tier, with `prominence`/`score` as the tiebreak (two places of equal
 * fame separate on size). Candidates the gazetteer never scored do not participate — they hold the rank population gave
 * them while the scored rows permute among their own slots (see {@link reorderMeasured}). Returns the input untouched
 * when fewer than two candidates are scored.
 *
 * **This is inert on the artifacts shipping today.** `candidate.db` carries no `place_importance` table and the FTS
 * `admin-global-priority.db` doesn't either, so `encyclopedic` is `undefined` on every candidate the Node path produces
 * and the abstention above fires every time. The measured scores live in `admin-global-priority-importance.db`, which
 * is not the artifact either backend opens. So this key is the CONSUMER, in place and pinned by tests, waiting on the
 * producer — see the receipt for what a candidate.db carrying `encyclopedic` would do to the four GB panel rows.
 */
export function rankByEncyclopedic<T extends Rankable>(candidates: readonly T[]): T[] {
	if (candidates.length < 2) return [...candidates]

	// Abstain entirely until at least one candidate carries a MEASURED score — the tier split
	// below is only meaningful as a tiebreak among scored rows. Without this, wiring the consumer
	// before the #28 producer reordered candidates on the exactMatch flag alone (meaning-of-zero:
	// an absent score must not act as evidence).
	if (!candidates.some(measured)) return [...candidates]

	const exact: T[] = []
	const rest: T[] = []

	for (const c of candidates) {
		// Tri-state exactMatch: only a stated TRUE earns the exact tier (see rankWithinTier).
		;(c.exactMatch === true ? exact : rest).push(c)
	}

	const compare = (a: T, b: T) => (b.encyclopedic ?? 0) - (a.encyclopedic ?? 0) || size(b) - size(a)

	return [...reorderMeasured(exact, compare), ...reorderMeasured(rest, compare)]
}

/**
 * Soft locale-country prior: `(prominence ?? score) + weight` for a candidate in `country`.
 *
 * Additive, never a filter — a far more prominent foreign namesake still wins (Zürich CH over Zurich KS) while a close
 * contest goes to the locale (Manchester NH over Manchester GB). No-op without a `country`, so the un-scoped path stays
 * byte-identical.
 *
 * The units matter: `prominence` on the candidate backend is log10(population + 1), so `weight` is read as "orders of
 * magnitude of population the in-country place is allowed to give away". Pass a large weight to make the country
 * effectively hard, `0` to disable.
 */
export function rankByCountryPrior<T extends Rankable>(
	candidates: readonly T[],
	country: string | undefined,
	weight: number = DEFAULT_COUNTRY_PRIOR_WEIGHT
): T[] {
	if (!country || candidates.length < 2) return [...candidates]
	const target = country.toUpperCase()

	const key = (c: T): number => size(c) + (c.country?.toUpperCase() === target ? weight : 0)

	return rankWithinTier(candidates, (a, b) => key(b) - key(a))
}
