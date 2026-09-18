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
 *
 *   Two further axes live here rather than in files of their own, because each is defined against this one:
 *   `Assertion`, whether a relationship is stated by a source or concluded by us, and `AssertedProposition`, which
 *   proposition a source asserts in a given field.
 */

/**
 * The five claims the evidence can license about a value, ordered from the strongest authority to none. Each result
 * carries exactly one. the constants are the wire values.
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
	 * No row matched. the value is the intersection of stated constraints. Never presentable as retrieved.
	 */
	Inferred: "inferred",
	/**
	 * The evidence does not support a claim. The answer the evidence gives rather than a failure to try.
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

/**
 * Which proposition a source asserts about a record. A third axis, orthogonal to both of the above: `EpistemicStatus`
 * answers what may be claimed about a value, `Assertion` answers whether a relationship is stated or concluded, and
 * this answers what the publisher is talking about at all.
 *
 * It is recorded per field, never per source. A company register is an authority on the identifier it issues, while the
 * registered-office string on the same row is an address somebody filed with it. One verdict for the whole source
 * cannot record both, and the compressed form reads as "trust nothing here" — which discards the identity the register
 * does assign.
 *
 * The constants are the wire values.
 */
export const AssertedProposition = {
	/**
	 * An entity or object exists under an identifier the publisher issues or regulates. A UPRN, an NPI, an LEI, a company
	 * number, a SIRET.
	 */
	Identity: "identity",
	/**
	 * Address components or designators are assigned to an addressable object. A national address register.
	 */
	Address: "address",
	/**
	 * A coordinate or footprint belongs to an identified object. An address point, a building centroid, a parcel.
	 */
	Geometry: "geometry",
	/**
	 * An address string was supplied or used in an operational context — a filing, a registration, a permit, a payment.
	 * The publisher attests only that it received this string. Whether the string is correct is a separate question.
	 */
	Observation: "observation",
	/**
	 * Legal or postal structure and rendition. UPU S42, a national postal guide, an address standard.
	 */
	Grammar: "grammar",
	/**
	 * Postal routing that is not geographic hierarchy. BFPO, APO/FPO/DPO, a foreign postcode prefix.
	 */
	Routing: "routing",
} as const

export type AssertedProposition = (typeof AssertedProposition)[keyof typeof AssertedProposition]
