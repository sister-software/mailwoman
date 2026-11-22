// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A mixed layer's license: an identifier whose obligations are those of the sources inside the layer,
 *   and the class each source is counted under.
 */

import type { TermsObligation } from "#decision"
import { LicenseObligation, licenseIdentifiers } from "#obligations"

/**
 * Whether a license expression contains a mixed identifier, `LicenseRef-<name>-Mixed`,
 * whose obligations are those of the sources inside the layer rather than of one license.
 */
export function isMixedLicenseExpression(expression: string): boolean {
	return licenseIdentifiers(expression).some((identifier) => /^LicenseRef-.+-Mixed$/u.test(identifier))
}

/**
 * How far one obligation of one source is established.
 */
export const ObligationState = {
	/**
	 * The terms the register read impose it.
	 */
	Required: "required",
	/**
	 * OpenAddresses' summary of the publisher's terms records it, and the register's reading imposes `none`.
	 *
	 * That summary is a third party's, so the notice credits the publisher without
	 * the register asserting a duty.
	 */
	Recorded: "recorded",
	/**
	 * The terms the register read ask for it without making it a condition.
	 */
	Requested: "requested",
	None: "none",
	/**
	 * The register records no reading of the publisher's terms for it,
	 * or the terms are in words no table reads.
	 */
	Unknown: "unknown",
} as const

export type ObligationState = (typeof ObligationState)[keyof typeof ObligationState]

/**
 * The obligation classes a mixed layer's sources are counted by, most demanding first.
 *
 * A source counts under its most demanding class.
 * The bill of materials and the notice list every obligation it owes.
 */
export const ObligationClass = {
	Unknown: "unknown",
	ShareAlike: "share-alike",
	/**
	 * The terms require indemnifying the publisher.
	 *
	 * The clause allocates liability and restricts no use, so it leaves the row's permissions as they are.
	 */
	Indemnity: "indemnity",
	/**
	 * The terms limit a use of the data, in words the notice quotes.
	 */
	UseRestriction: "use-restriction",
	/**
	 * The terms require a text, such as a disclaimer, to travel with the data.
	 */
	NoticePassThrough: "notice-pass-through",
	Attribution: "attribution",
	AttributionRequested: "attribution requested",
	AttributionRecorded: "attribution recorded by OpenAddresses",
	None: "none",
} as const

export type ObligationClass = (typeof ObligationClass)[keyof typeof ObligationClass]

/**
 * What one source of a mixed layer owes: its attribution and share-alike states,
 * and the obligations its deciding decision records in the publisher's words.
 */
export interface SourceObligations {
	attribution: ObligationState
	shareAlike: ObligationState
	obligations: readonly TermsObligation[]
}

/**
 * The class a source is counted under: an unknown obligation first, then share-alike,
 * indemnity, a use restriction, a notice to pass on, and attribution.
 */
export function obligationClassOf(source: SourceObligations): ObligationClass {
	if (source.attribution === ObligationState.Unknown || source.shareAlike === ObligationState.Unknown) {
		return ObligationClass.Unknown
	}

	if (source.shareAlike !== ObligationState.None) return ObligationClass.ShareAlike

	const owes = (obligation: LicenseObligation) => source.obligations.some((entry) => entry.obligation === obligation)

	if (owes(LicenseObligation.Indemnity)) return ObligationClass.Indemnity

	if (owes(LicenseObligation.UseRestriction)) return ObligationClass.UseRestriction

	if (owes(LicenseObligation.NoticePassThrough)) return ObligationClass.NoticePassThrough

	if (source.attribution === ObligationState.Required) return ObligationClass.Attribution

	if (source.attribution === ObligationState.Requested) return ObligationClass.AttributionRequested

	if (source.attribution === ObligationState.Recorded) return ObligationClass.AttributionRecorded

	return ObligationClass.None
}
