/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares resolver candidate tables for a base query and a refined query. A refinement may reorder candidates, add
 *   them, or remove ones that the added information contradicts. Every other removal must be explained by a hierarchy
 *   re-scope or a full fetch window.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { ResolveCandidateTrace, ResolveNodeTrace } from "@mailwoman/core/resolver"

/**
 * Mutually exclusive explanations for a candidate's movement between the two tables.
 */
export const CANDIDATE_ACCOUNTS = ["held", "contradicted", "rescoped", "beyond_window", "unexplained"] as const

export type CandidateAccount = (typeof CANDIDATE_ACCOUNTS)[number]

/**
 * Whether a candidate stayed in the table, left it, or entered it after refinement.
 */
export const CANDIDATE_DIRECTIONS = ["held", "removed", "added"] as const

export type CandidateDirection = (typeof CANDIDATE_DIRECTIONS)[number]

/**
 * Classification and ranks for one candidate.
 */
export interface CandidateReading {
	/**
	 * Key of the lookup that holds this candidate.
	 */
	lookup: string
	/**
	 * Candidate identity in the form `${placetype}:${id}`.
	 */
	key: string
	name: string
	country: string
	account: CandidateAccount
	direction: CandidateDirection
	/**
	 * One-based rank in the base pool.
	 * It is absent when the base pool lacks the candidate.
	 */
	baseRank?: number
	/**
	 * One-based rank in the refined pool.
	 * It is absent when the refined pool lacks the candidate.
	 */
	variantRank?: number
	/**
	 * Resolver evidence for the account.
	 */
	reason: string
}

/**
 * Query scope that a lookup ran under.
 */
interface LookupScope {
	country?: string
	parentID?: string | number
	postcode?: string
	regionQualifier?: string
}

/**
 * Candidate merged across repeated records of one lookup.
 */
interface PooledCandidate {
	key: string
	name: string
	country: string
	/**
	 * Best one-based rank across the repeated records.
	 */
	rank: number
}

/**
 * Repeated trace records of one lookup merged into one observation.
 */
export interface LookupFold {
	/**
	 * Key in the form `tag|placetype|foldedValue`.
	 */
	key: string
	tag: string
	placetype: string
	value: string
	/**
	 * Number of merged records.
	 */
	records: number
	pool: Map<string, PooledCandidate>
	/**
	 * Largest fetch limit among the records.
	 */
	limit: number
	/**
	 * Whether any record reached its fetch limit or had truncated candidates.
	 */
	windowed: boolean
	scope: LookupScope
	/**
	 * Distinct resolver checks in first-seen order.
	 */
	checks: string[]
	/**
	 * Source of the last picked candidate, or `null` when no record picked one.
	 */
	pickedSource: string | null
}

/**
 * Merges trace records into one observation per lookup key.
 * The key folds the value by trimming and lowercasing it.
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

		// A full or truncated pool may have hidden candidates beyond its limit.
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
 * Describes the hierarchy scopes that the refined lookup added or changed.
 * It returns `null` when the scopes match.
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
 * Number of candidate readings per account.
 */
export type CandidateAccountCounts = Record<CandidateAccount, number>

/**
 * Result of comparing a base and a refined query's candidate tables.
 */
export interface RefinementReading {
	/**
	 * Verdict for the pair.
	 *
	 * `diverges` means some movement is unexplained.
	 * `unmeasured` means some removal happened in a full window.
	 *
	 * `undecidable` means no lookup ran on both sides.
	 * `refines` means every movement is explained.
	 */
	relation: "refines" | "diverges" | "unmeasured" | "undecidable"
	basis: string
	differences: string[]
	counts: CandidateAccountCounts
	readings: CandidateReading[]
	/**
	 * Number of lookups that ran in both queries.
	 */
	pairedLookups: number
	/**
	 * Lookups that only the refined query ran.
	 */
	addedLookups: string[]
	/**
	 * Lookups that only the base query ran.
	 *
	 * They appear in the differences and do not affect the relation.
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
 * Appends a reading for every candidate that either side of a paired lookup holds.
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

		// A country contradiction explains the removal even when the refined pool is windowed.
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

		// A full base window may have hidden this candidate, so its addition counts as explained.
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
 * Compares the candidate tables of a base query and its refinement.
 *
 * Both arguments are records from the resolver's `ResolveOpts.traceSink`.
 * `base` holds the coarser query's records, and `variant` holds the refined query's records.
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

	// Windowed removals leave the comparison unmeasured.
	// Windowed additions count as explained.
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
