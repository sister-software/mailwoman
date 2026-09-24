/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compare resolver candidate tables to test refinement monotonicity: adding query information may reorder or expand
 *   candidates, and may remove candidates contradicted by that information, but must not remove compatible candidates.
 *   Account for country contradictions, hierarchy re-scoping, and fetch-window limits separately. A removal at the
 *   fetch window is unmeasured, not a pass. Pair lookups by tag, placetype, and folded value; fold repeated lookups
 *   within each run before comparison.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { ResolveCandidateTrace, ResolveNodeTrace } from "@mailwoman/core/resolver"

/**
 * Mutually exclusive candidate accounts: held, contradicted, rescoped,
 * beyond the observed window, or unexplained.
 */
export const CANDIDATE_ACCOUNTS = ["held", "contradicted", "rescoped", "beyond_window", "unexplained"] as const

export type CandidateAccount = (typeof CANDIDATE_ACCOUNTS)[number]

/**
 * Side on which a candidate was observed.
 */
export const CANDIDATE_DIRECTIONS = ["held", "removed", "added"] as const

export type CandidateDirection = (typeof CANDIDATE_DIRECTIONS)[number]

/**
 * Classification and ranks for one candidate.
 */
export interface CandidateReading {
	/**
	 * Key of the lookup containing this candidate.
	 */
	lookup: string
	/**
	 * Stable identity including placetype, `${placetype}:${id}`.
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
	 * Resolver evidence supporting the account, including held candidates.
	 */
	reason: string
}

/**
 * Scope recorded for one lookup.
 */
interface LookupScope {
	country?: string
	parentID?: string | number
	postcode?: string
	regionQualifier?: string
}

/**
 * Candidate pooled across repeated instances of one lookup.
 */
interface PooledCandidate {
	key: string
	name: string
	country: string
	/**
	 * Best rank across repeated lookups.
	 */
	rank: number
}

/**
 * Repeated records of one lookup folded into one observation.
 */
export interface LookupFold {
	/**
	 * `tag|placetype|foldedValue` key.
	 */
	key: string
	tag: string
	placetype: string
	value: string
	/**
	 * Number of records combined.
	 */
	records: number
	pool: Map<string, PooledCandidate>
	/**
	 * The widest fetch window any record ran with.
	 */
	limit: number
	/**
	 * Whether any record filled or overflowed its candidate window.
	 */
	windowed: boolean
	scope: LookupScope
	/**
	 * Distinct resolver checks, in first-seen order.
	 */
	checks: string[]
	/**
	 * Pick source, or `null` when no candidate was selected.
	 */
	pickedSource: string | null
}

/**
 * Fold trace records into one observation per lookup.
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
				checks: [],
				pickedSource: null,
			}

			folds.set(key, fold)
		}

		fold.records += 1
		fold.limit = Math.max(fold.limit, record.query.limit)

		// Mark pools at their fetch limit or with trace-truncated candidates as windowed.
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

		for (const check of record.checks) {
			if (!fold.checks.includes(check)) {
				fold.checks.push(check)
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
 * Identify hierarchy scopes that make the refined lookup a different population.
 */
function rescopedPath(base: LookupScope, variant: LookupScope): string | null {
	const parts: string[] = []

	if (variant.parentID !== undefined && variant.parentID !== base.parentID) {
		parts.push(`parent ${variant.parentID}`)
	}

	if (variant.regionQualifier && variant.regionQualifier !== base.regionQualifier) {
		parts.push(`region qualifier ${stringifyJSON(variant.regionQualifier)}`)
	}

	if (variant.postcode && variant.postcode !== base.postcode) {
		parts.push(`postcode ${variant.postcode}`)
	}

	return parts.length ? parts.join(" + ") : null
}

/**
 * Counts by candidate account.
 */
export type CandidateAccountCounts = Record<CandidateAccount, number>

/**
 * Result of comparing one pair of candidate tables.
 */
export interface RefinementReading {
	/**
	 * `refines` when all movement is explained; `diverges` when movement is unexplained;
	 * `unmeasured` when removals hit a fetch window; `undecidable` when no lookups pair.
	 */
	relation: "refines" | "diverges" | "unmeasured" | "undecidable"
	basis: string
	differences: string[]
	counts: CandidateAccountCounts
	readings: CandidateReading[]
	/**
	 * Lookups performed in both runs; denominator for account counts.
	 */
	pairedLookups: number
	/**
	 * Lookups performed only by the refined query.
	 */
	addedLookups: string[]
	/**
	 * Lookups performed only by the base; reported but not graded.
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
		parts.push(`qualifier=${stringifyJSON(scope.regionQualifier)}`)
	}

	if (scope.postcode) {
		parts.push(`postcode=${scope.postcode}`)
	}

	return parts.length ? parts.join(" ") : "unscoped"
}

/**
 * Classify candidates for a paired lookup.
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

		// Country contradiction is directly testable, even when the pool is windowed.
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
				(variant.checks.length ? ` · \`checks\` ${variant.checks.join(", ")}` : "") +
				` · pick ${variant.pickedSource ?? "none"}`,
		})
	}

	for (const candidate of variant.pool.values()) {
		if (base.pool.has(candidate.key)) continue

		// A candidate beyond the base window was not observed absent, so its addition is not unexplained.
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
				(variant.checks.length ? ` · \`checks\` ${variant.checks.join(", ")}` : "") +
				` · pick ${variant.pickedSource ?? "none"}`,
		})
	}
}

/**
 * Read a refinement pair's candidate tables.
 *
 * `base` is the coarser query's records and `variant` the refined query's.
 * Both come from the resolver's own `ResolveOpts.traceSink`; neither is re-derived here.
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

	// Only windowed removals make the comparison unmeasured; windowed additions are explained.
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
