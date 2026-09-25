/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { CandidateTable } from "#candidate/schema"

/**
 * The candidate-row fields that {@link rankByPrimaryPreference} reads.
 *
 * `is_primary` is optional, so an older artifact without the column skips the re-rank without an error.
 */
export type PrimaryPreferenceRow = Pick<CandidateTable, "neg_rank" | "country_id"> &
	Partial<Pick<CandidateTable, "is_primary" | "placetype_id" | "population" | "name_role">>

/**
 * The log10-population penalty applied to an alias row when the top primary-name
 * row for the same key is in another country.
 *
 * An alias at least 10 times as populous still wins, so alternate names such as "LA" keep working.
 */
export const PRIMARY_PREFERENCE_LOG10 = 1

const SEAT_PLACETYPE = "locality"

/**
 * The number of population-ordered rows fetched per name key before
 * {@link rankByPrimaryPreference} re-ranks them.
 *
 * A fetch of only the caller's `limit` could miss the intended primary behind more populous foreign aliases.
 */
export const RERANK_FETCH = 64

/**
 * A candidate row with its re-ranked `effectiveNegRank` and its `demoted` flag.
 */
export type RankedRow<R> = R & {
	/**
	 * `neg_rank` plus any cross-country alias penalty.
	 *
	 * Rows are ordered by this value, and the emitted `prominence` derives from it.
	 *
	 * The raw `neg_rank` stays on the row for the resolver's minimum winning score.
	 */
	effectiveNegRank: number

	/**
	 * True when this row is a cross-country alias that the penalty moved behind
	 * the top primary for the same key.
	 *
	 * A demoted row loses `exactMatch`, so the resolver's country pin cannot promote
	 * a coincidental foreign exonym back over the primary.
	 * A dominant alias and a same-country alias are never demoted.
	 */
	demoted: boolean

	/**
	 * True when this row came from the typo-correction fallback, which runs only after the exact probes miss.
	 *
	 * The row is still returned and ranked, but it never claims `exactMatch`.
	 */
	fuzzy?: boolean

	/**
	 * Whether the row lies inside the query's region qualifier.
	 *
	 * The candidate lookup sets it when the artifact has the ancestors sidecar.
	 *
	 * When the field is absent, containment was not checked.
	 */
	containedByQualifier?: boolean

	/**
	 * Set only when the variant-alias exemption spared this row the cross-country alias penalty.
	 */
	variantExempted?: true
}

/**
 * Re-ranks population-ordered candidate rows so a cross-country alias must beat the top
 * primary by `delta` in log10 population, and returns the top `limit` rows.
 *
 * When `placetypes` is given, an exact tie prefers a populated `locality`,
 * which orders a seat town ahead of a district with the same name and population.
 */
export function rankByPrimaryPreference<R extends PrimaryPreferenceRow>(
	rows: readonly R[],
	limit: number,
	delta = PRIMARY_PREFERENCE_LOG10,
	placetypes?: ReadonlyMap<number, string>,
	exemptVariantAliases = false
): Array<RankedRow<R>> {
	let topPrimary: R | undefined

	for (const r of rows) {
		if (r.is_primary === 1 && (topPrimary == null || r.neg_rank < topPrimary.neg_rank)) {
			topPrimary = r
		}
	}

	const topCountry = topPrimary?.country_id

	const wouldPenalize = (r: R): boolean =>
		typeof topCountry === "number" && r.is_primary !== 1 && r.country_id !== topCountry

	const isCrossCountryAlias = (r: R): boolean =>
		wouldPenalize(r) && !(exemptVariantAliases && r.name_role === "variant")

	const annotate = (r: R): RankedRow<R> => {
		const penalized = isCrossCountryAlias(r)
		const effectiveNegRank = r.neg_rank + (penalized ? delta : 0)

		const exempted = !penalized && exemptVariantAliases && r.name_role === "variant" && wouldPenalize(r)

		return {
			...r,
			effectiveNegRank,
			demoted: penalized && effectiveNegRank > topPrimary!.neg_rank,
			...(exempted ? { variantExempted: true as const } : {}),
		}
	}

	const seatPreference = (r: R): number =>
		placetypes != null &&
		typeof r.placetype_id === "number" &&
		typeof r.population === "number" &&
		r.population > 0 &&
		placetypes.get(r.placetype_id) === SEAT_PLACETYPE
			? 1
			: 0

	const unmeasuredPrimary = (r: R): number =>
		r.is_primary === 1 && typeof r.population === "number" && r.population === 0 ? 1 : 0

	return (
		rows
			.map((r, i) => ({ row: annotate(r), i }))

			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
			.sort(
				(a, b) =>
					a.row.effectiveNegRank - b.row.effectiveNegRank ||
					a.row.neg_rank - b.row.neg_rank ||
					seatPreference(b.row) - seatPreference(a.row) ||
					unmeasuredPrimary(b.row) - unmeasuredPrimary(a.row) ||
					a.i - b.i
			)
			.slice(0, limit)
			.map((x) => x.row)
	)
}
