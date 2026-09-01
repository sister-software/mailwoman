/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refinement monotonicity read off the resolver's own candidate tables (#1923). Pure — it takes two lists
 *   of {@linkcode ResolveNodeTrace} and returns a reading; it never runs a geocode and never asks a backend
 *   anything.
 *
 *   WHAT THE LAW SAYS. Adding information to a query must not make an admissible candidate inadmissible. It
 *   may reorder the pool, it may add to it, and it may remove a candidate the added information CONTRADICTS.
 *   What it may not do is drop a candidate that is still compatible with everything the query says.
 *
 *   `top5(refined) ⊆ top5(base)` IS NOT THAT LAW, and the difference is the whole reason this module exists.
 *   A subset assertion fails on a valid refinement that surfaces a candidate which was sixth before, and it
 *   passes on a real violation whenever the dropped candidate happened to sit past the window. Both readings
 *   are measured here instead of assumed: the walk's fetch window is recorded per lookup as
 *   {@linkcode ResolveNodeTrace.query.limit} (5 by default) and the trace's own cap reports its overflow as
 *   `candidatesTruncated`, so "absent" and "absent from what we looked at" are different findings.
 *
 *   FIVE ACCOUNTS, AND `unexplained` IS THE ONLY ONE THAT FAILS. Every candidate on either side is assigned
 *   exactly one — see {@linkcode CANDIDATE_ACCOUNTS}. A candidate the refined lookup's country scope
 *   contradicts is an EXPLAINED removal. A candidate that left a lookup re-scoped through a different
 *   hierarchy path is an explained removal too, and the account names the path. A candidate absent from a
 *   table that was sitting at its window is not evidence of anything, and says so.
 *
 *   A REMOVAL AT THE WINDOW LEAVES THE ROW `unmeasured`, NOT PASSING. That is the one place this instrument
 *   is deliberately less conclusive than a verdict: the observation could not decide the question, and
 *   reporting the law as holding there would count a blind spot as evidence. An addition at the window is a
 *   different matter and does NOT hold the row back — the law constrains what refinement REMOVES, so a
 *   candidate the coarse table was too small to show is explained by the window rather than unexplained by it.
 *
 *   LOOKUPS ARE PAIRED BY WHAT WAS ASKED, NOT BY WHEN. The pairing key is tag + placetype + folded value, so
 *   the base's unscoped `Springfield` lookup pairs with the refined query's `Springfield` lookup under
 *   Illinois, which is exactly the pair the law is about. Repeats of one lookup within a single run are FOLDED
 *   into one pool: the walk records `#lookupAndPick` per call and a query can reach the same lookup twice, so
 *   counting them apart would report one pool as two.
 */

import type { ResolveCandidateTrace, ResolveNodeTrace } from "@mailwoman/core/resolver"

/**
 * The closed set of accounts a candidate can be assigned. Every candidate observed on either side gets exactly one, and
 * the name states what was READ rather than what it implies for the verdict.
 *
 * - `held` — present in both pools. Its rank may have moved; a rank change is reported and never fails, because the law
 *   is about admissibility and a reordering leaves every candidate admissible.
 * - `contradicted` — gone, and the refined lookup ran under a country scope the candidate's own country fails. The
 *   removal is explained by the information the query added, which is the one removal the law permits.
 * - `rescoped` — gone (or new), and the refined lookup ran through a hierarchy path the base's did not: a `parentID` or a
 *   region qualifier the coarse query could not supply. The pool is a different population, and the account names the
 *   path that made it one.
 * - `beyond_window` — gone (or new), and the table on the OTHER side was sitting at its recorded fetch window, so the
 *   candidate may be one row past the edge. An observation, not a finding.
 * - `unexplained` — gone (or new) with no contradiction, no re-scope, and a table that had room to spare. On a removal
 *   this is the law failing. On an addition it is the unrelated candidate-set expansion the law also refuses.
 */
export const CANDIDATE_ACCOUNTS = ["held", "contradicted", "rescoped", "beyond_window", "unexplained"] as const

export type CandidateAccount = (typeof CANDIDATE_ACCOUNTS)[number]

/**
 * Which pool a candidate was observed in. `held` candidates are in both; the other two name the side that has it.
 */
export const CANDIDATE_DIRECTIONS = ["held", "removed", "added"] as const

export type CandidateDirection = (typeof CANDIDATE_DIRECTIONS)[number]

/**
 * One candidate's reading.
 */
export interface CandidateReading {
	/**
	 * The lookup this candidate belongs to, as {@linkcode LookupFold.key}.
	 */
	lookup: string
	/**
	 * Stable identity — `${placetype}:${id}`. The placetype travels with the id because the walk probes several bands and
	 * a bare gazetteer id says nothing about which band answered.
	 */
	key: string
	name: string
	country: string
	account: CandidateAccount
	direction: CandidateDirection
	/**
	 * 1-based final rank in the base pool, absent when the base never held it.
	 */
	baseRank?: number
	/**
	 * 1-based final rank in the refined pool, absent when the refined lookup never held it.
	 */
	variantRank?: number
	/**
	 * What the account was read FROM, in the resolver's own vocabulary. Carried on every reading, including the ones that
	 * hold: an account stated only on failures cannot be checked against the run that passed.
	 */
	reason: string
}

/**
 * The scope one lookup ran under, as the walk recorded it.
 */
interface LookupScope {
	country?: string
	parentID?: string | number
	postcode?: string
	regionQualifier?: string
}

/**
 * One candidate as pooled across the repeats of a single lookup.
 */
interface PooledCandidate {
	key: string
	name: string
	country: string
	/**
	 * The BEST final rank observed across the repeats. A candidate that ranked 5th once and 2nd another time was
	 * reachable at 2, and the pessimistic reading would invent a demotion the walk never performed.
	 */
	rank: number
}

/**
 * Every record of one lookup, folded into a single observation.
 */
export interface LookupFold {
	/**
	 * `tag|placetype|foldedValue` — what was asked, not when. See the module docstring.
	 */
	key: string
	tag: string
	placetype: string
	value: string
	/**
	 * How many records folded into this one. Greater than one means the walk reached the same lookup more than once.
	 */
	records: number
	pool: Map<string, PooledCandidate>
	/**
	 * The widest fetch window any record ran with.
	 */
	limit: number
	/**
	 * Did any record fill or overflow its window? True means absence from this pool is not evidence of inadmissibility.
	 */
	windowed: boolean
	scope: LookupScope
	/**
	 * Every `gates` entry across the records, in first-seen order — the resolver's own mechanism vocabulary.
	 */
	gates: string[]
	/**
	 * The provenance of the pick, or `null` when the lookup resolved nothing. `null` is a claim; absence of the fold is
	 * the thing that means nobody asked.
	 */
	pickedSource: string | null
}

/**
 * Fold a run's trace records into one observation per lookup.
 *
 * Exported because both the comparator and the law suite's own tests read the folds directly — a reading that could
 * only be inspected through its final relation would make every disagreement about this module a debugging exercise.
 */
export function foldLookups(records: readonly ResolveNodeTrace[]): Map<string, LookupFold> {
	const folds = new Map<string, LookupFold>()

	for (const record of records) {
		const key = `${record.tag}|${record.placetype}|${record.value.trim().toLocaleLowerCase()}`

		let fold = folds.get(key)

		if (!fold) {
			fold = {
				key,
				tag: record.tag,
				placetype: record.placetype,
				value: record.value,
				records: 0,
				pool: new Map(),
				limit: record.query.limit,
				windowed: false,
				scope: {},
				gates: [],
				pickedSource: null,
			}

			folds.set(key, fold)
		}

		fold.records += 1
		fold.limit = Math.max(fold.limit, record.query.limit)

		// Two independent ways a table can be short of the candidate universe: the walk asked for `limit` rows and got
		// that many (so the backend had at least one more to give), or the trace's own cap dropped a tail it counted.
		if (record.candidatesTruncated > 0 || record.candidates.length >= record.query.limit) {
			fold.windowed = true
		}

		if (record.query.country) {
			fold.scope.country = record.query.country
		}

		if (record.query.parentID !== undefined) {
			fold.scope.parentID = record.query.parentID
		}

		if (record.query.postcode) {
			fold.scope.postcode = record.query.postcode
		}

		if (record.query.regionQualifier) {
			fold.scope.regionQualifier = record.query.regionQualifier
		}

		for (const gate of record.gates) {
			if (!fold.gates.includes(gate)) {
				fold.gates.push(gate)
			}
		}

		if (record.picked) {
			fold.pickedSource = record.picked.source
		}

		record.candidates.forEach((candidate, index) => {
			const candidateKey = candidateKeyOf(candidate)
			const existing = fold.pool.get(candidateKey)

			if (existing) {
				existing.rank = Math.min(existing.rank, index + 1)
			} else {
				fold.pool.set(candidateKey, {
					key: candidateKey,
					name: candidate.name,
					country: candidate.country ?? "",
					rank: index + 1,
				})
			}
		})
	}

	return folds
}

function candidateKeyOf(candidate: ResolveCandidateTrace): string {
	return `${candidate.placetype}:${candidate.id}`
}

/**
 * Did the refined lookup run through a hierarchy path the base's did not?
 *
 * A `parentID` or a region qualifier the coarse query could not supply re-points the lookup at a different population.
 * A country scope is deliberately NOT read here — it is a per-candidate predicate the candidate row can be tested
 * against, so it earns the sharper {@linkcode CANDIDATE_ACCOUNTS} `contradicted` account instead.
 */
function rescopedPath(base: LookupScope, variant: LookupScope): string | null {
	const parts: string[] = []

	if (variant.parentID !== undefined && variant.parentID !== base.parentID) {
		parts.push(`parent ${variant.parentID}`)
	}

	if (variant.regionQualifier && variant.regionQualifier !== base.regionQualifier) {
		parts.push(`region qualifier ${JSON.stringify(variant.regionQualifier)}`)
	}

	if (variant.postcode && variant.postcode !== base.postcode) {
		parts.push(`postcode ${variant.postcode}`)
	}

	return parts.length ? parts.join(" + ") : null
}

/**
 * Per-account totals across every paired lookup.
 */
export type CandidateAccountCounts = Record<CandidateAccount, number>

/**
 * What one refinement pair's candidate tables said.
 */
export interface RefinementReading {
	/**
	 * - `refines` — every removal is accounted for and every addition is explained; the law holds over the observed pool.
	 * - `diverges` — a candidate left the pool unexplained, or one entered it unexplained.
	 * - `unmeasured` — no unexplained movement, but at least one removal sat at a fetch window, so the law is UNPROVEN
	 *   rather than holding.
	 * - `undecidable` — no lookup ran on both sides, so there is no pool to compare.
	 */
	relation: "refines" | "diverges" | "unmeasured" | "undecidable"
	basis: string
	differences: string[]
	counts: CandidateAccountCounts
	readings: CandidateReading[]
	/**
	 * Lookups both runs performed — the denominator every count above is stated over.
	 */
	pairedLookups: number
	/**
	 * Lookups only the refined query performed, as {@linkcode LookupFold.key}. Expected on a refinement: the added text
	 * names a place the coarse query never mentioned.
	 */
	addedLookups: string[]
	/**
	 * Lookups only the BASE performed. Reported rather than graded — a refinement that stops probing a value it still
	 * carries has changed its hierarchy path, and that is a finding a reader wants beside the pool counts.
	 */
	droppedLookups: string[]
}

function emptyCounts(): CandidateAccountCounts {
	return { held: 0, contradicted: 0, rescoped: 0, beyond_window: 0, unexplained: 0 }
}

function describeScope(scope: LookupScope): string {
	const parts: string[] = []

	if (scope.country) {
		parts.push(`country=${scope.country}`)
	}

	if (scope.parentID !== undefined) {
		parts.push(`parent=${scope.parentID}`)
	}

	if (scope.regionQualifier) {
		parts.push(`qualifier=${JSON.stringify(scope.regionQualifier)}`)
	}

	if (scope.postcode) {
		parts.push(`postcode=${scope.postcode}`)
	}

	return parts.length ? parts.join(" ") : "unscoped"
}

/**
 * Account for one paired lookup's candidates, appending to `readings`.
 */
function accountLookup(base: LookupFold, variant: LookupFold, readings: CandidateReading[]): void {
	const rescope = rescopedPath(base.scope, variant.scope)

	for (const candidate of base.pool.values()) {
		const inVariant = variant.pool.get(candidate.key)

		if (inVariant) {
			readings.push({
				lookup: base.key,
				key: candidate.key,
				name: candidate.name,
				country: candidate.country,
				account: "held",
				direction: "held",
				baseRank: candidate.rank,
				variantRank: inVariant.rank,
				reason:
					candidate.rank === inVariant.rank
						? `still admissible at rank ${inVariant.rank}`
						: `still admissible, rank ${candidate.rank} → ${inVariant.rank}`,
			})

			continue
		}

		// Country first: it is the one constraint the candidate row can be tested against, so it is provable
		// whatever the window did. Window second, because an unprovable removal must not read as an explained one.
		if (variant.scope.country && candidate.country && candidate.country !== variant.scope.country) {
			readings.push({
				lookup: base.key,
				key: candidate.key,
				name: candidate.name,
				country: candidate.country,
				account: "contradicted",
				direction: "removed",
				baseRank: candidate.rank,
				reason: `country ${candidate.country} fails the refined lookup's country=${variant.scope.country} scope`,
			})

			continue
		}

		if (variant.windowed) {
			readings.push({
				lookup: base.key,
				key: candidate.key,
				name: candidate.name,
				country: candidate.country,
				account: "beyond_window",
				direction: "removed",
				baseRank: candidate.rank,
				reason: `the refined table was at its window (${variant.pool.size} rows, limit ${variant.limit}) — absence here cannot decide admissibility`,
			})

			continue
		}

		if (rescope) {
			readings.push({
				lookup: base.key,
				key: candidate.key,
				name: candidate.name,
				country: candidate.country,
				account: "rescoped",
				direction: "removed",
				baseRank: candidate.rank,
				reason: `the refined lookup ran through a different hierarchy path (${rescope}), so its pool is a different population`,
			})

			continue
		}

		readings.push({
			lookup: base.key,
			key: candidate.key,
			name: candidate.name,
			country: candidate.country,
			account: "unexplained",
			direction: "removed",
			baseRank: candidate.rank,
			reason:
				`admissible at rank ${candidate.rank} before refinement and gone after, from a table with room ` +
				`(${variant.pool.size} of ${variant.limit}) under ${describeScope(variant.scope)}` +
				(variant.gates.length ? ` · \`gates\` ${variant.gates.join(", ")}` : "") +
				` · pick ${variant.pickedSource ?? "none"}`,
		})
	}

	for (const candidate of variant.pool.values()) {
		if (base.pool.has(candidate.key)) continue

		// The base's own window is what explains an addition: a candidate the coarse table was too small to show was
		// never observed as absent, so its arrival is not expansion. This is the reading a top-K subset assertion gets
		// wrong in the direction that fails valid refinements.
		if (base.windowed) {
			readings.push({
				lookup: variant.key,
				key: candidate.key,
				name: candidate.name,
				country: candidate.country,
				account: "beyond_window",
				direction: "added",
				variantRank: candidate.rank,
				reason: `the base table was at its window (${base.pool.size} rows, limit ${base.limit}), so this candidate was never observed absent`,
			})

			continue
		}

		if (rescope) {
			readings.push({
				lookup: variant.key,
				key: candidate.key,
				name: candidate.name,
				country: candidate.country,
				account: "rescoped",
				direction: "added",
				variantRank: candidate.rank,
				reason: `reached through a hierarchy path the base lookup did not run (${rescope})`,
			})

			continue
		}

		readings.push({
			lookup: variant.key,
			key: candidate.key,
			name: candidate.name,
			country: candidate.country,
			account: "unexplained",
			direction: "added",
			variantRank: candidate.rank,
			reason:
				`entered at rank ${candidate.rank} with no added constraint and no re-scope, from a base table with ` +
				`room (${base.pool.size} of ${base.limit})` +
				(variant.gates.length ? ` · \`gates\` ${variant.gates.join(", ")}` : "") +
				` · pick ${variant.pickedSource ?? "none"}`,
		})
	}
}

/**
 * Read a refinement pair's candidate tables.
 *
 * `base` is the coarser query's records and `variant` the refined query's. Both come from the resolver's own
 * `ResolveOpts.traceSink`; neither is re-derived here.
 */
export function accountRefinement(
	base: readonly ResolveNodeTrace[],
	variant: readonly ResolveNodeTrace[]
): RefinementReading {
	const baseFolds = foldLookups(base)
	const variantFolds = foldLookups(variant)
	const paired = [...baseFolds.keys()].filter((key) => variantFolds.has(key))
	const addedLookups = [...variantFolds.keys()].filter((key) => !baseFolds.has(key))
	const droppedLookups = [...baseFolds.keys()].filter((key) => !variantFolds.has(key))
	const readings: CandidateReading[] = []

	for (const key of paired) {
		accountLookup(baseFolds.get(key)!, variantFolds.get(key)!, readings)
	}

	const counts = emptyCounts()

	for (const reading of readings) {
		counts[reading.account] += 1
	}

	const windows = paired
		.map((key) => {
			const a = baseFolds.get(key)!
			const b = variantFolds.get(key)!

			return `${key} [base ${a.pool.size}/${a.limit}${a.windowed ? " at window" : ""} ${describeScope(a.scope)} → refined ${b.pool.size}/${b.limit}${b.windowed ? " at window" : ""} ${describeScope(b.scope)}]`
		})
		.join(" · ")

	const basis =
		`${paired.length} paired lookup(s), ${addedLookups.length} added, ${droppedLookups.length} dropped · ` +
		`accounts ${CANDIDATE_ACCOUNTS.map((account) => `${account} ${counts[account]}`).join(", ")}` +
		(windows ? ` · ${windows}` : "")

	if (!paired.length) {
		return {
			relation: "undecidable",
			basis,
			differences: [
				`no lookup ran on both sides — base performed ${baseFolds.size} lookup(s), the refined query ` +
					`${variantFolds.size}, and none of them asked the same thing, so there is no pool to compare`,
			],
			counts,
			readings,
			pairedLookups: 0,
			addedLookups,
			droppedLookups,
		}
	}

	const differences = readings
		.filter((reading) => reading.account !== "held" || reading.baseRank !== reading.variantRank)
		.map(
			(reading) =>
				`${reading.lookup} · ${reading.account}/${reading.direction} · ${reading.name} (${reading.country} ${reading.key}) — ${reading.reason}`
		)

	if (droppedLookups.length) {
		differences.push(`the refined query performed no lookup for ${droppedLookups.join(", ")}`)
	}

	const unexplained = readings.filter((reading) => reading.account === "unexplained")

	if (unexplained.length) {
		return {
			relation: "diverges",
			basis,
			differences,
			counts,
			readings,
			pairedLookups: paired.length,
			addedLookups,
			droppedLookups,
		}
	}

	// Only a REMOVAL at the window holds the row back. The law constrains what refinement removes, so a candidate the
	// coarse table was too small to show is explained by that window rather than left unproven by it.
	const unprovable = readings.filter(
		(reading) => reading.account === "beyond_window" && reading.direction === "removed"
	)

	if (unprovable.length) {
		return {
			relation: "unmeasured",
			basis,
			differences,
			counts,
			readings,
			pairedLookups: paired.length,
			addedLookups,
			droppedLookups,
		}
	}

	return {
		relation: "refines",
		basis,
		differences,
		counts,
		readings,
		pairedLookups: paired.length,
		addedLookups,
		droppedLookups,
	}
}
