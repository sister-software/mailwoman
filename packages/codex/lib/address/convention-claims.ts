/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Provenance for an addressing convention, recorded as a claim with one observation per source.
 *
 *   A convention has several sources and they answer different questions. A designated postal operator states
 *   what its own addresses are. UPU S42 states what a conforming address looks like, which an operator may not
 *   follow. libaddressinput states what a global input system believes a user must supply. The OpenCage
 *   address-formatting templates state what a global geocoder has learned it needs in order to render. Each is
 *   evidence about a different thing, so a single field naming one of them as the basis answers the question by
 *   discarding the rest.
 *
 *   Every observation is kept, including one that contradicts the claim. A disagreement between what an
 *   authority publishes and what an input system requires is a fact about the jurisdiction rather than an error
 *   to resolve, and a reader deciding how much to trust a layout needs to see it.
 */

import type { AddressLayout } from "#address/layout"

/**
 * A body whose statement about an addressing convention this repository reads.
 */
export const ConventionSource = {
	/**
	 * The country's own addressing rules, as its designated postal operator publishes them:
	 * USPS Publication 28, Royal Mail's addressing guidance, La Poste's NF Z 10-011,
	 * the South African Post Office's system.
	 *
	 * This is the native authority.
	 * Every other source below describes, maps or approximates it.
	 */
	NationalPostalAuthority: "national-postal-authority",
	/**
	 * UPU's Postal Addressing Systems compendium, which describes a member country's system.
	 *
	 * A third party collected the description rather than the country publishing it,
	 * so it can lag the rules it describes.
	 */
	PostalAddressingSystems: "upu-pas",
	/**
	 * The country's UPU S42 template.
	 *
	 * S42 is not the domestic system.
	 * The template maps the country's existing structure into a common set of international
	 * elements, and UPU builds it with that country's own representative, tests it against
	 * representative address forms, and has the country approve it before publication.
	 *
	 * So a template is an approved crosswalk of national semantics rather than a formatting
	 * recommendation, and it carries that weight even where the country routes no mail by S42.
	 * `#address/s42-templates` records which 72 jurisdictions have one.
	 */
	PostalStandardS42: "upu-s42",
	/**
	 * libaddressinput, Google's address metadata.
	 *
	 * Its `fmt` and `lfmt` fields state which components print and in what order.
	 */
	LibAddressInput: "libaddressinput",
	/**
	 * The OpenCage address-formatting templates, read once for which slot leads a street line.
	 */
	OpenCageAddressFormatting: "opencage-address-formatting",
	/**
	 * This repository's own locale board, where a layout was checked against real addresses.
	 */
	MailwomanBoard: "mailwoman-board",
} as const

/**
 * One of the {@link ConventionSource} values.
 */
export type ConventionSource = (typeof ConventionSource)[keyof typeof ConventionSource]

/**
 * What kind of authority an observation carries, which decides what a reader may conclude from it.
 */
export const ObservationKind = {
	/**
	 * The authority's own statement about its addresses.
	 */
	Authoritative: "authoritative",
	/**
	 * A mapping of one country's address semantics into a shared vocabulary,
	 * which that country's representative built and the country approved.
	 *
	 * Stronger than a recommendation, because the country agreed to it.
	 * Weaker than the native authority, because it states the shared vocabulary's terms
	 * rather than the country's own, and the two can drift apart after approval.
	 */
	ApprovedCrosswalk: "approved-crosswalk",
	/**
	 * A third party's account of an authority's system, which can lag the rules it describes.
	 */
	Description: "description",
	/**
	 * What an input system believes a user must supply.
	 */
	Implementation: "implementation",
	/**
	 * What a renderer has learned it needs in order to print an address.
	 */
	Rendering: "rendering",
	/**
	 * Addresses seen in use, such as a board entry checked against real mail.
	 */
	Observed: "observed",
} as const

/**
 * One of the {@link ObservationKind} values.
 */
export type ObservationKind = (typeof ObservationKind)[keyof typeof ObservationKind]

/**
 * The kind each source's statements carry.
 *
 * The mapping is fixed by what the source is, so an observation records its source
 * and reads its kind from here rather than restating it.
 */
export const KIND_BY_SOURCE: Readonly<Record<ConventionSource, ObservationKind>> = {
	[ConventionSource.NationalPostalAuthority]: ObservationKind.Authoritative,
	[ConventionSource.PostalAddressingSystems]: ObservationKind.Description,
	[ConventionSource.PostalStandardS42]: ObservationKind.ApprovedCrosswalk,
	[ConventionSource.LibAddressInput]: ObservationKind.Implementation,
	[ConventionSource.OpenCageAddressFormatting]: ObservationKind.Rendering,
	[ConventionSource.MailwomanBoard]: ObservationKind.Observed,
}

/**
 * Whether a source's statement agrees with the claim.
 *
 * Three of the four values distinguish states that a two-valued field would merge.
 * `Silent` means the source was read and addresses something else.
 *
 * `Unread` means a statement exists on record and nobody here has retrieved it,
 * which is what tells a reader there is a document to go and read.
 * A source with no statement at all contributes no observation, so it cannot be mistaken for either.
 */
export const ObservationStance = {
	Supports: "supports",
	Contradicts: "contradicts",
	Silent: "silent",
	Unread: "unread",
} as const

/**
 * One of the {@link ObservationStance} values.
 */
export type ObservationStance = (typeof ObservationStance)[keyof typeof ObservationStance]

/**
 * One source's statement about one claim.
 */
export interface ConventionObservation {
	readonly source: ConventionSource
	readonly kind: ObservationKind
	readonly stance: ObservationStance
	/**
	 * Where the statement was read, so a later reader can check it rather than take it.
	 */
	readonly readFrom: string
}

/**
 * The claims this module can answer from what the package holds.
 *
 * Each is a proposition about one jurisdiction's addressing convention, phrased
 * so that a source either supports it, contradicts it, or stays silent on it.
 */
export const ConventionClaimID = {
	/**
	 * The postcode prints before the locality on the same line or an earlier one.
	 */
	PostcodePrecedesLocality: "postcode-precedes-locality",
	/**
	 * The house number prints before the street name.
	 */
	HouseNumberPrecedesStreet: "house-number-precedes-street",
	/**
	 * The largest administrative unit prints first, as in the CJK order.
	 */
	LargestUnitFirst: "largest-unit-first",
} as const

/**
 * One of the {@link ConventionClaimID} values.
 */
export type ConventionClaimID = (typeof ConventionClaimID)[keyof typeof ConventionClaimID]

/**
 * A claim about one jurisdiction, with every source's statement about it.
 */
export interface ConventionClaim {
	readonly claim: ConventionClaimID
	readonly jurisdiction: string
	readonly observations: readonly ConventionObservation[]
}

/**
 * Whether the observations disagree: at least one supports the claim and at least one contradicts it.
 *
 * The function reports the disagreement and does not resolve it.
 * A caller that needs one answer decides which {@link ObservationKind} it trusts
 * for its purpose, which is a different decision per purpose: a validator wants the
 * implementation's belief and a renderer wants the renderer's.
 */
export function observationsDisagree(claim: ConventionClaim): boolean {
	const supports = claim.observations.some((entry) => entry.stance === ObservationStance.Supports)
	const contradicts = claim.observations.some((entry) => entry.stance === ObservationStance.Contradicts)

	return supports && contradicts
}

/**
 * Builds one observation, reading its kind from {@link KIND_BY_SOURCE}.
 *
 * Named for its return type because `@mailwoman/evidence` exports an `observation` of its own,
 * which records a value a source reported at a vintage rather than a stance on a claim.
 */
export function conventionObservation(
	source: ConventionSource,
	stance: ObservationStance,
	readFrom: string
): ConventionObservation {
	return { source, kind: KIND_BY_SOURCE[source], stance, readFrom }
}

/**
 * Reads a layout's stance on one claim, or `Silent` when the layout names
 * neither component the claim compares.
 *
 * A layout is evidence about the source it was derived from rather than about the
 * jurisdiction, so the caller supplies which source the layout stands for.
 */
export function stanceFromLayout(
	claim: ConventionClaimID,
	layout: AddressLayout,
	printedTags: readonly string[]
): ObservationStance {
	switch (claim) {
		case ConventionClaimID.PostcodePrecedesLocality: {
			return orderStance(printedTags, "postcode", "locality")
		}

		case ConventionClaimID.HouseNumberPrecedesStreet: {
			return orderStance(printedTags, "house_number", "street")
		}

		case ConventionClaimID.LargestUnitFirst: {
			const region = printedTags.indexOf("region")
			const street = printedTags.findIndex((tag) => tag === "street" || tag === "house_number")

			if (region === -1 || street === -1) return ObservationStance.Silent

			return region < street ? ObservationStance.Supports : ObservationStance.Contradicts
		}

		default: {
			// Every claim id is handled above.
			// A new one reads as unexamined rather than as agreement.
			void layout

			return ObservationStance.Silent
		}
	}
}

function orderStance(printedTags: readonly string[], earlier: string, later: string): ObservationStance {
	const first = printedTags.indexOf(earlier)
	const second = printedTags.indexOf(later)

	if (first === -1 || second === -1) return ObservationStance.Silent

	return first < second ? ObservationStance.Supports : ObservationStance.Contradicts
}
