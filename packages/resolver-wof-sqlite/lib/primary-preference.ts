// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { latLonBoundsContain } from "@mailwoman/spatial/bbox"

import type { CandidateTable } from "#candidate/schema"

/**
 * The candidate-row fields that {@link rankByPrimaryPreference} reads.
 *
 * `is_primary` is optional, so an older artifact without the column skips the re-rank without an error.
 */
export type PrimaryPreferenceRow = Pick<CandidateTable, "neg_rank"> &
	Partial<Pick<CandidateTable, "is_primary" | "placetype_id" | "population" | "name_role">>

/**
 * The log10-population penalty applied to an alias row when another row holds
 * the same key as its primary name.
 *
 * An alias at least 10 times as populous still wins, so alternate names such as "LA"
 * and misspellings of a large city such as "Dehli" keep working.
 */
export const PRIMARY_PREFERENCE_LOG10 = 1

/**
 * The alias penalty inside a stated region, larger than any log10 population gap.
 *
 * A query that states the region (`Junction, IL`) has already chosen among the world's namesakes,
 * so a place whose primary name equals the query outranks a different place that lists it as an alias.
 * WOF `und` variant names include former names of absorbed communities, such as `Junction` on West
 * Chicago, and a population gap between the two places is no evidence of which one the query means.
 */
export const REGION_PRIMARY_PREFERENCE_LOG10 = 100

/**
 * The alias penalty inside a stated region for one alias row against the top primary row.
 *
 * A primary row inside the alias row's extent records the same place twice,
 * as the Setauket hamlet inside the Setauket-East Setauket census place,
 * so the worldwide margin applies and population decides.
 * A primary row outside it is a different place, and the region margin applies.
 */
export function regionAliasMargin(
	alias: Partial<Pick<CandidateTable, "min_lat" | "min_lon" | "max_lat" | "max_lon">>,
	primary: Partial<Pick<CandidateTable, "latitude" | "longitude">>
): number {
	const { min_lat: minLat, min_lon: minLon, max_lat: maxLat, max_lon: maxLon } = alias
	const { latitude, longitude } = primary

	if (minLat == null || minLon == null || maxLat == null || maxLon == null || latitude == null || longitude == null) {
		return REGION_PRIMARY_PREFERENCE_LOG10
	}

	return latLonBoundsContain({ minLat, minLon, maxLat, maxLon }, latitude, longitude)
		? PRIMARY_PREFERENCE_LOG10
		: REGION_PRIMARY_PREFERENCE_LOG10
}

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
	 * `neg_rank` plus any alias penalty.
	 *
	 * Rows are ordered by this value.
	 * The emitted `prominence` derives from it.
	 *
	 * The raw `neg_rank` stays on the row for the resolver's minimum winning score.
	 */
	effectiveNegRank: number

	/**
	 * True when this row is an alias that the penalty moved behind the top primary for the same key.
	 *
	 * A demoted row loses `exactMatch`, so the resolver's country pin cannot promote
	 * a coincidental exonym back over the primary.
	 * A dominant alias is never demoted.
	 */
	demoted: boolean

	/**
	 * True when this row came from the typo-correction fallback.
	 * The fallback runs only after the exact probes miss.
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
 * Re-ranks population-ordered candidate rows.
 *
 * An alias must beat the top primary by `delta` in log10 population, in any country.
 * A `delta` function returns the margin for one alias row against the top primary row.
 * The function returns the top `limit` rows.
 *
 * When `placetypes` is given, an exact tie prefers a populated `locality`.
 * This places a seat town ahead of a district with the same name and population.
 */
export function rankByPrimaryPreference<R extends PrimaryPreferenceRow>(
	rows: readonly R[],
	limit: number,
	delta: number | ((alias: R, primary: R) => number) = PRIMARY_PREFERENCE_LOG10,
	placetypes?: ReadonlyMap<number, string>,
	exemptVariantAliases = false
): Array<RankedRow<R>> {
	let topPrimary: R | null = null

	for (const r of rows) {
		if (r.is_primary === 1 && (topPrimary == null || r.neg_rank < topPrimary.neg_rank)) {
			topPrimary = r
		}
	}

	const isAliasOfPrimary = (r: R): boolean => topPrimary != null && r.is_primary !== 1

	const annotate = (r: R): RankedRow<R> => {
		const exempted = exemptVariantAliases && r.name_role === "variant" && isAliasOfPrimary(r)
		const penalized = isAliasOfPrimary(r) && !exempted
		const margin = penalized ? (typeof delta === "number" ? delta : delta(r, topPrimary!)) : 0
		const effectiveNegRank = r.neg_rank + margin

		return {
			...r,
			effectiveNegRank,
			demoted: penalized && effectiveNegRank > topPrimary!.neg_rank,
			...(exempted ? { variantExempted: true as const } : {}),
		}
	}

	const seatPreference = (r: R): number =>
		placetypes &&
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
