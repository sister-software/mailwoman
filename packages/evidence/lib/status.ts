/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The epistemic axis — WHAT MAY BE CLAIMED about a value, kept strictly separate from the mechanism that
 *   produced it. A geocode result's `resolution_tier` answers "how was this coordinate produced" (`address_point`,
 *   `interpolated`, …); this answers "what does the evidence permit us to say". A rooftop matched against a national
 *   register the authority declares complete is `designated`; the same rooftop matched against a crowdsourced extract
 *   is `observed`. Same mechanism, different authority, and collapsing them silently upgrades a source's observation
 *   into an authority's designation.
 */

/**
 * The five claims the evidence can license about a value, ordered from the strongest authority to none. Each result
 * carries exactly one; the constants are the wire values.
 */
export const EpistemicStatus = {
	/**
	 * An authority assigned this. A UPRN, a BAN address, an official postcode.
	 */
	Designated: "designated",
	/**
	 * A named source recorded it at a named vintage. An OSM node, an Overture row.
	 */
	Observed: "observed",
	/**
	 * Computed from observations by a stated rule — an interpolated house number, a street centroid.
	 */
	Derived: "derived",
	/**
	 * No row matched; the value is the intersection of stated constraints. Never presentable as retrieved.
	 */
	Inferred: "inferred",
	/**
	 * The evidence does not support a claim. The answer the evidence gives, not a failure to try.
	 */
	Unresolved: "unresolved",
} as const

export type EpistemicStatus = (typeof EpistemicStatus)[keyof typeof EpistemicStatus]

/**
 * Whether a relationship is stated by a source or concluded by us.
 *
 * `filer.db` enforces the companion rule in SQL — `filer_family_match_score_inferred_only` — because a match score on
 * an authoritative link means the link was never authoritative. `relation()` in `./evidence.ts` enforces the same rule
 * for callers who build one outside a database.
 */
export const Assertion = {
	Authoritative: "authoritative",
	Inferred: "inferred",
} as const

export type Assertion = (typeof Assertion)[keyof typeof Assertion]
