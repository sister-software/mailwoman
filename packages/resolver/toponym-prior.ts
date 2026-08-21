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
 *   inverts by a factor of eight). What it measures is a BLENDED global toponym prior
 *   (`ResolvedPlace.importance`): the concordance's encyclopedia-derived channel where a concordance
 *   matched, a population-derived proxy everywhere else — the one scale on which every bearer of a
 *   name is scored comparably, which is the precondition for comparing them at all.
 *   {@link rankByImportance} consumes it. (The STRICT encyclopedia-evidence channel keeps its own
 *   reserved slot, `ResolvedPlace.encyclopedic`, which no ranking key reads and no shipped artifact
 *   yet populates — see `core/resolver/types.ts`.)
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
 *      rank population gave it while the scored rows reorder among themselves. On a candidate.db built
 *      before the #28 `importance` column, nothing is scored, so {@link rankByImportance} is
 *      byte-stable by construction.
 *   3. **Stable.** Equal keys keep their incoming order, so the backend's own ranking survives underneath. That order
 *      carries decisions only the backend can make — the candidate backend's seat tiebreak
 *      (`resolver-wof-sqlite/primary-preference.ts`) reaches an end-to-end answer solely through this stability
 *      (#1729), so equal-key stability here is load-bearing, not cosmetic.
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
 * Importance margin below which two SAME-COUNTRY bearers are a tie, and the tie falls back to referential (size) order.
 * Ratified 2026-08-11 (the five bare-query flip decisions): bare `Springfield` must stay on the referential answer —
 * the live chain is IL 0.612605 → MA 0.611142 → MO 0.596195 (adjacent gaps 0.0015 and 0.0149, full span 0.0164), so the
 * band must cover at least the 0.0149 adjacent gap for the trio to chain into one cluster.
 *
 * The band never compares across countries, and that scope is forced by decided rows, not preference: Windsor's
 * accepted flip (GB 0.564842 over CA 0.560687) sits at a 0.0042 gap — inside ANY band that covers Springfield. The two
 * decisions are only co-satisfiable if the band binds same-country pairs alone. That is also what the §2 referential
 * policy (ROAD_TO_V9) says: within a country the geocoder ranks referentially; the blended prior's job is the
 * cross-country question — which country's bearer a bare query meant.
 */
const SAME_COUNTRY_IMPORTANCE_TIE_BAND = 0.02

/**
 * The fields a ranking key reads. Structural rather than `ResolvedPlace` so the backend's own `PlaceCandidate` (a
 * structural twin) can be ranked without a cast.
 */
type Rankable = Pick<ResolvedPlace, "score"> &
	Partial<Pick<ResolvedPlace, "country" | "exactMatch" | "importance" | "prominence">>

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
 * A candidate the gazetteer actually scored. An absent value means "the score source never measured this place" OR
 * "this artifact predates the column" OR "the join refused the row" — three different things, none of them zero.
 */
const measured = (c: Rankable): boolean => typeof c.importance === "number" && Number.isFinite(c.importance)

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
 * GB takes the lead, and TC never moves.
 */
function reorderMeasured<T extends Rankable>(tier: readonly T[], order: (measuredRows: T[]) => T[]): T[] {
	const slots: number[] = []

	for (const [i, c] of tier.entries()) {
		if (measured(c)) {
			slots.push(i)
		}
	}

	if (slots.length < 2) return [...tier]
	const sorted = order(slots.map((i) => tier[i]!))
	const out = [...tier]

	for (const [k, slot] of slots.entries()) {
		out[slot] = sorted[k]!
	}

	return out
}

/**
 * The importance ordering over MEASURED rows, with the {@link SAME_COUNTRY_IMPORTANCE_TIE_BAND} applied.
 *
 * Same-country bearers whose adjacent importance gaps sit inside the band chain into one cluster (transitive on purpose
 * — otherwise the boundary would depend on comparison order), and a cluster orders its members referentially (size
 * DESC). Clusters — including every cross-country row, which is always its own cluster — rank by their most important
 * member, then head size, then input order. A cluster therefore moves as a unit: a same-country near-tie cannot be
 * split by a foreign row falling between its members' scores.
 */
function orderMeasuredByImportance<T extends Rankable>(rows: readonly T[]): T[] {
	// Group by country in first-appearance order; a row without a country can never substantiate a
	// same-country tie, so it stays a singleton.
	const groups = new Map<string, { firstIndex: number; members: T[] }>()
	const clusters: Array<{ firstIndex: number; members: T[] }> = []

	for (const [i, row] of rows.entries()) {
		const country = row.country?.toUpperCase()

		if (!country) {
			clusters.push({ firstIndex: i, members: [row] })

			continue
		}

		const group = groups.get(country)

		if (group) {
			group.members.push(row)
		} else {
			groups.set(country, { firstIndex: i, members: [row] })
		}
	}

	for (const group of groups.values()) {
		const sorted = group.members.toSorted((a, b) => b.importance! - a.importance! || size(b) - size(a))
		let open: T[] = []

		for (const row of sorted) {
			if (open.length && open.at(-1)!.importance! - row.importance! > SAME_COUNTRY_IMPORTANCE_TIE_BAND) {
				clusters.push({ firstIndex: group.firstIndex, members: open })
				open = []
			}

			open.push(row)
		}

		if (open.length) {
			clusters.push({ firstIndex: group.firstIndex, members: open })
		}
	}

	const keyed = clusters.map((cluster) => ({
		firstIndex: cluster.firstIndex,
		key: Math.max(...cluster.members.map((m) => m.importance!)),
		members: cluster.members.toSorted((a, b) => size(b) - size(a)),
	}))

	keyed.sort((a, b) => b.key - a.key || size(b.members[0]!) - size(a.members[0]!) || a.firstIndex - b.firstIndex)

	return keyed.flatMap((c) => c.members)
}

/**
 * Importance-first ordering — the #28 fame prior, consumed.
 *
 * Ranks by `importance` DESC within the exact tier, with `prominence`/`score` as the tiebreak (two places of equal fame
 * separate on size). Candidates the gazetteer never scored do not participate — they hold the rank population gave them
 * while the scored rows permute among their own slots (see {@link reorderMeasured}). Returns the input untouched when
 * fewer than two candidates are scored.
 *
 * The producer is the candidate build's `importance` column (#28) — the BLENDED prior (the concordance's
 * encyclopedia-derived channel where a concordance matched, a population-derived proxy elsewhere; see
 * `candidate-schema.ts` → `CandidateTable.importance` for why the strict channel is deliberately NOT what lands there).
 * On an artifact predating the column, `importance` is `undefined` on every candidate the backend produces and the
 * abstention below keeps the ranking byte-stable.
 *
 * Flip decisions, ratified 2026-08-11: bare `Moscow`→Москва, `Manchester`→GB, `Fulda`→DE, `Cambridge`→GB are ACCEPTED
 * behavior — all cross-country contests, where this prior answers the question population cannot. Bare `Springfield`
 * ABSTAINS to the referential answer via {@link SAME_COUNTRY_IMPORTANCE_TIE_BAND}; no candidate is dropped, so the
 * runner-up survives as a declared alternative downstream.
 */
export function rankByImportance<T extends Rankable>(candidates: readonly T[]): T[] {
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

	return [...reorderMeasured(exact, orderMeasuredByImportance), ...reorderMeasured(rest, orderMeasuredByImportance)]
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
