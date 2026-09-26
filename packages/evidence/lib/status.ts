/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The epistemic axis — what may be claimed about a value, kept strictly separate from the mechanism that
 * produced it: a rooftop matched against a national register the authority declares complete is `designated`, while the
 * same rooftop matched against a crowdsourced extract is `observed`, and collapsing them silently upgrades a source's
 * observation into an authority's designation.
 *
 * `Assertion`, whether a relationship is stated by a source or concluded by us, and `AssertedProposition`, which
 * proposition a source asserts in a given field, live here because each is defined against this axis.
 */

/**
 * The five claims the evidence can license about a value, ordered from the strongest authority
 * to none, with each answer naming exactly one and the constants as the wire values.
 */
export const EpistemicStatus = {
	/**
	 * An authority assigned this — a uprn, a BAN address, an official postcode.
	 */
	Designated: "designated",
	/**
	 * A named source recorded it at a named vintage, such as an OSM node or an Overture row.
	 */
	Observed: "observed",
	/**
	 * Computed from observations by a stated rule — an interpolated house number, a street centroid.
	 */
	Derived: "derived",
	/**
	 * No row matched, so the value is the intersection of stated constraints
	 * and is never presentable as retrieved.
	 */
	Inferred: "inferred",
	/**
	 * The evidence does not support a claim — the answer the evidence gives rather than a failure to try.
	 */
	Unresolved: "unresolved",
} as const

export type EpistemicStatus = (typeof EpistemicStatus)[keyof typeof EpistemicStatus]

/**
 * Whether a relationship is stated by a source or concluded by us, enforced by `filer.db`'s
 * `filer_family_match_score_inferred_only` SQL rule and by `relation()` in `./evidence.ts`,
 * because a match score on an authoritative link means the link was never authoritative.
 */
export const Assertion = {
	Authoritative: "authoritative",
	Inferred: "inferred",
} as const

export type Assertion = (typeof Assertion)[keyof typeof Assertion]

/**
 * Which proposition a source asserts about a record, recorded per field rather than per source:
 * a company register is an authority on the identifier it issues while the registered-office
 * string on the same row is an address somebody filed with it, so one verdict for the whole
 * source reads as "trust no value here" and discards the identity the register does assign.
 */
export const AssertedProposition = {
	/**
	 * An entity or object exists under an identifier the publisher issues or regulates,
	 * such as a uprn, an NPI, an LEI, a company number or a siret.
	 */
	Identity: "identity",
	/**
	 * Address components or designators are assigned to an addressable object,
	 * as in a national address register.
	 */
	Address: "address",
	/**
	 * A coordinate or footprint belongs to an identified object, such as an address point,
	 * a building centroid or a parcel.
	 */
	Geometry: "geometry",
	/**
	 * An address string was supplied or used in an operational context — a filing,
	 * a registration, a permit, a payment — where the publisher attests only that it
	 * received the string and whether it is correct is a separate question.
	 */
	Observation: "observation",
	/**
	 * Legal or postal structure and rendition, defined by UPU S42, a national
	 * postal guide or an address standard.
	 */
	Grammar: "grammar",
	/**
	 * Postal routing that is not geographic hierarchy, such as BFPO, APO/FPO/DPO
	 * or a foreign postcode prefix.
	 */
	Routing: "routing",
} as const

export type AssertedProposition = (typeof AssertedProposition)[keyof typeof AssertedProposition]
