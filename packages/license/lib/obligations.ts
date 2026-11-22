// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Summarizes the obligations of an SPDX license expression for `mailwoman doctor`.
 *   The summary is a debugging aid and gives no legal advice.
 */

import { ExpressionOperator, licenseExpressionTerms, licenseWithoutException } from "#expression"

/**
 * The obligation classes the summary reports.
 *
 * - `attribution` requires crediting the source where derived results are shown or redistributed.
 * - `share_alike` requires a derived work or database to use the same license, as in ODbL and AGPL.
 * - `source_offer` requires offering the source, including modifications,
 *   to network users (AGPL-3.0 section 13).
 *
 * Three more classes arise only from a publisher's own terms, never from an SPDX license,
 * so `KNOWN_OBLIGATIONS` assigns none of them.
 * A license decision records them in its `obligations` field with the publisher's words.
 *
 * - `use_restriction` limits a use of the data without withholding it, such as a
 *   mailing-list ban or `not intended for use in mapping products for resale`.
 *   The quoted limit is the obligation.
 * - `notice_pass_through` requires a text, such as a disclaimer, to travel with the data
 *   or with an application built on it.
 *   The text is printed verbatim wherever the data is passed on.
 * - `indemnity` requires the user to indemnify, defend or hold harmless the publisher.
 *   It allocates liability and restricts no use, so it decides no operation's permission.
 */
export const LicenseObligation = {
	Attribution: "attribution",
	ShareAlike: "share_alike",
	SourceOffer: "source_offer",
	UseRestriction: "use_restriction",
	NoticePassThrough: "notice_pass_through",
	Indemnity: "indemnity",
} as const

/**
 * An obligation class.
 */
export type LicenseObligation = (typeof LicenseObligation)[keyof typeof LicenseObligation]

/**
 * The known obligations of each SPDX identifier.
 *
 * An empty list means the license has no obligations.
 * An identifier missing from the table is reported as unrecognized so that an
 * unknown license never reads as obligation-free.
 */
const KNOWN_OBLIGATIONS: ReadonlyMap<string, readonly LicenseObligation[]> = new Map<
	string,
	readonly LicenseObligation[]
>([
	["AGPL-3.0-only", [LicenseObligation.Attribution, LicenseObligation.ShareAlike, LicenseObligation.SourceOffer]],
	["AGPL-3.0-or-later", [LicenseObligation.Attribution, LicenseObligation.ShareAlike, LicenseObligation.SourceOffer]],
	// Section 4 of commercial-LICENSE.md requires attribution.
	["LicenseRef-Commercial", [LicenseObligation.Attribution]],
	["ODbL-1.0", [LicenseObligation.Attribution, LicenseObligation.ShareAlike]],
	// Open Data Commons publishes an attribution-only license beside ODbL.
	// Readers confuse them because both are ODC.
	// This one has no share-alike term.
	["ODC-By-1.0", [LicenseObligation.Attribution]],
	// Every identifier `readLicenseRecord` can resolve a share-alike mention to belongs here,
	// so a stated CC-BY-SA grant reads as carrying share-alike rather than as an unrecognized identifier.
	["CC-BY-SA-4.0", [LicenseObligation.Attribution, LicenseObligation.ShareAlike]],
	["CC-BY-SA-3.0", [LicenseObligation.Attribution, LicenseObligation.ShareAlike]],
	["CC-BY-SA-2.0", [LicenseObligation.Attribution, LicenseObligation.ShareAlike]],
	["OGL-UK-3.0", [LicenseObligation.Attribution]],
	["CDLA-Permissive-2.0", [LicenseObligation.Attribution]],
	["CC-BY-4.0", [LicenseObligation.Attribution]],
	["CC0-1.0", []],
	["PDDL-1.0", []],
	// The Datenlizenz Deutschland pair.
	// Zero permits any use without restrictions or conditions.
	// Namensnennung requires a source note naming the provider, the license and the dataset URI.
	// It also requires a mark on changed data.
	// Both texts are retained at internal/strategy/rights-receipts/address-skeletons-2026-10-17/.
	["DL-DE-ZERO-2.0", []],
	["DL-DE-BY-2.0", [LicenseObligation.Attribution]],
	// US Government works have no copyright under 17 U.S.C. § 105. SPDX has no identifier for them, so this
	// `LicenseRef` is defined in docs/engineering/reference/layer-interface.mdx.
	["LicenseRef-USGov-Public-Domain", []],
	// BAN publishes under Licence Ouverte 2.0.
	["etalab-2.0", [LicenseObligation.Attribution]],
	// The Taiwanese address registers behind Overture-TW use this license.
	// The grant is void without the attribution statement, so the per-agency
	// attribution list ships with the data.
	["OGDL-Taiwan-1.0", [LicenseObligation.Attribution]],
	// Mexico's national statistics institute publishes under its own "Términos de Libre Uso de la
	// Información del INEGI", which identifies no Creative Commons license and includes no version.
	// The terms permit copying, publishing, adapting, extracting and commercial use.
	// They require the credit `Fuente: INEGI, <product name>`.
	// They state no share-alike term.
	// Retrieved 2026-09-27 and retained at internal/strategy/rights-receipts/mx-gb-2026-09-27/mx-inegi-terminos.html.
	["LicenseRef-INEGI-Terms", [LicenseObligation.Attribution]],
	// The GEBCO undersea gazetteer, under the operator's own election of 2026-11-02 (#2896).
	// GEBCO and NOAA NCEI publish it with a citation request and no stated restriction.
	// The disclaimer excludes only navigation and safety-at-sea use.
	// The election rests on that publication without a written grant, and a request for one has gone to GEBCO.
	// The citation is the obligation it records.
	["LicenseRef-GEBCO-Operator-Election", [LicenseObligation.Attribution]],
	// The Who's On First records (#3163).
	// Each repository's `LICENSE.md` requires a link back to that license.
	// The attribution notice holds the link.
	// Its sources' grants require their credits.
	// Wikipedia supplies 14 point geometries and 2,338 populations under CC BY-SA 3.0.
	// Those are facts.
	// The license's Section 2 leaves uses free from copyright unrestricted.
	// Its share-alike term therefore reaches none of them.
	// No record the admin build reads takes geometry or a stored property from
	// a source the WOF source list types as restricted or non-commercial.
	// docs/engineering/reference/layer-interface.mdx records the count.
	["LicenseRef-WhosOnFirst-Mixed", [LicenseObligation.Attribution]],
	// `LicenseRef-US-Mixed`, the US address layer, is deliberately absent.
	// Its sources owe different obligations, and the build admits only those the register lets it
	// serve. docs/engineering/reference/layer-interface.mdx counts them by basis and obligation class.
	["MIT", [LicenseObligation.Attribution]],
	["Apache-2.0", [LicenseObligation.Attribution]],
])

/**
 * A summarized license expression.
 */
export interface LicenseSummary {
	/**
	 * The expression as recorded.
	 */
	expression: string
	/**
	 * The expression's identifiers in order.
	 * `AGPL-3.0-only OR LicenseRef-Commercial` has two.
	 */
	identifiers: string[]
	/**
	 * The union of the known obligations of every identifier.
	 *
	 * For `OR`, this union applies until a branch is chosen, as `chooseLicenseBranch` in
	 * `@mailwoman/core/license/branch` does for Mailwoman's own license.
	 */
	obligations: LicenseObligation[]
	/**
	 * Whether every identifier is in the known table.
	 *
	 * `NOASSERTION`, a vendor-suffixed identifier such as `pddl-1.0-USGov-nrcs`
	 * and a misspelling are all unrecognized.
	 */
	recognized: boolean
	/**
	 * The identifiers missing from the known table.
	 */
	unrecognized: string[]
}

/**
 * Splits an SPDX expression into its identifiers.
 *
 * The function removes parentheses and splits on `AND` and `OR`.
 * A `WITH` exception stays attached to its license.
 */
export function licenseIdentifiers(expression: string): string[] {
	return licenseExpressionTerms(expression, [ExpressionOperator.And, ExpressionOperator.Or])
}

/**
 * Summarizes the known obligations of an SPDX expression.
 */
export function summarizeLicense(expression: string): LicenseSummary {
	const identifiers = licenseIdentifiers(expression)
	const obligations = new Set<LicenseObligation>()
	const unrecognized: string[] = []

	for (const identifier of identifiers) {
		const known = KNOWN_OBLIGATIONS.get(licenseWithoutException(identifier))

		if (!known) {
			unrecognized.push(identifier)

			continue
		}

		for (const obligation of known) {
			obligations.add(obligation)
		}
	}

	return {
		expression,
		identifiers,
		obligations: [...obligations],
		recognized: identifiers.length > 0 && unrecognized.length === 0,
		unrecognized,
	}
}

const LICENSE_REF = /^LicenseRef-[A-Za-z0-9.-]+$/u

/**
 * Throws unless every identifier in the expression may be recorded in a layer manifest.
 *
 * An admissible identifier is in the obligations table, matches `LicenseRef-…`, or is `NOASSERTION`.
 * A `WITH` exception is ignored, as it is in {@link summarizeLicense}.
 * The doctor reports `NOASSERTION` as degraded.
 *
 * A manifest is sealed, so an unknown identifier is rejected at build time.
 */
export function assertAdmissibleLicenseExpression(expression: string, context = "license"): void {
	for (const identifier of licenseIdentifiers(expression)) {
		const license = licenseWithoutException(identifier)

		if (license === "NOASSERTION" || KNOWN_OBLIGATIONS.has(license) || LICENSE_REF.test(license)) continue

		throw new Error(
			`${context}: ${JSON.stringify(identifier)} is not an admissible license identifier. Use the SPDX identifier the obligations table knows (packages/license/lib/obligations.ts), a LicenseRef- this repository defines, or NOASSERTION.`
		)
	}
}
