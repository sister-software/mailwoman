/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Summarizes the obligations of an SPDX license expression for `mailwoman doctor`. The summary is a debugging
 *   aid and gives no legal advice.
 */

import { stringifyJSON } from "#json"
import type { LicenseKeyVerification } from "#license/key/index"
import type { LicenseKeyPublication } from "#license/publication"

/**
 * The obligation classes the summary reports.
 *
 * - `attribution` requires crediting the source where derived results are shown or redistributed.
 * - `share_alike` requires a derived work or database to carry the same license, as in ODbL and AGPL.
 * - `source_offer` requires offering the source, including modifications,
 *   to network users (AGPL-3.0 section 13).
 */
export const LicenseObligation = {
	Attribution: "attribution",
	ShareAlike: "share_alike",
	SourceOffer: "source_offer",
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
	["OGL-UK-3.0", [LicenseObligation.Attribution]],
	["CDLA-Permissive-2.0", [LicenseObligation.Attribution]],
	["CC-BY-4.0", [LicenseObligation.Attribution]],
	["CC0-1.0", []],
	["PDDL-1.0", []],
	// US Government works have no copyright under 17 U.S.C. § 105. SPDX has no identifier for them, so this
	// `LicenseRef` is defined in docs/engineering/reference/layer-interface.mdx.
	["LicenseRef-USGov-Public-Domain", []],
	// BAN publishes under Licence Ouverte 2.0.
	["etalab-2.0", [LicenseObligation.Attribution]],
	// The Taiwanese address registers behind Overture-TW use this license.
	// The grant is void without the attribution statement, so the per-agency
	// attribution list ships with the data.
	["OGDL-Taiwan-1.0", [LicenseObligation.Attribution]],
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
	 * For `OR`, this union applies until a branch is chosen with {@link chooseLicenseBranch}.
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
	return expression
		.replaceAll(/[()]/g, " ")
		.split(/\s+(?:AND|OR)\s+/i)
		.map((part) => part.trim())
		.filter((part) => part.length)
}

/**
 * Returns the license part of an identifier, without any `WITH` exception.
 */
function withoutException(identifier: string): string {
	return identifier.split(/\s+WITH\s+/i)[0]!
}

/**
 * Summarizes the known obligations of an SPDX expression.
 */
export function summarizeLicense(expression: string): LicenseSummary {
	const identifiers = licenseIdentifiers(expression)
	const obligations = new Set<LicenseObligation>()
	const unrecognized: string[] = []

	for (const identifier of identifiers) {
		const known = KNOWN_OBLIGATIONS.get(withoutException(identifier))

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

/**
 * Returns the branch of mailwoman's license expression that applies to this installation.
 *
 * The commercial branch applies only when the key is `valid` and the published
 * key register has not marked it retired or unlisted.
 * The doctor passes both the key and the register status.
 * The stamp runs offline and passes only the key.
 */
export function appliedLicenseBranch(
	expression: string,
	key?: LicenseKeyVerification,
	publication?: LicenseKeyPublication
): string {
	const retired = publication === "retired" || publication === "unlisted"

	return chooseLicenseBranch(expression, { commercialAgreement: key?.status === "valid" && !retired })
}

/**
 * Chooses the applicable branch of an `A OR B` expression.
 *
 * The first `LicenseRef-` branch applies when there is a commercial agreement.
 * Otherwise the first open-source branch applies.
 * An expression without `OR` is returned unchanged.
 */
export function chooseLicenseBranch(expression: string, options: { commercialAgreement: boolean }): string {
	const branches = expression
		.replaceAll(/[()]/g, " ")
		.split(/\s+OR\s+/i)
		.map((part) => part.trim())
		.filter((part) => part.length)

	if (branches.length < 2) return expression

	const commercial = branches.find((branch) => branch.startsWith("LicenseRef-"))
	const open = branches.find((branch) => !branch.startsWith("LicenseRef-"))

	if (options.commercialAgreement && commercial) return commercial

	return open ?? branches[0]!
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
		const license = withoutException(identifier)

		if (license === "NOASSERTION" || KNOWN_OBLIGATIONS.has(license) || LICENSE_REF.test(license)) continue

		throw new Error(
			`${context}: ${stringifyJSON(identifier)} is not an admissible license identifier. Use the SPDX identifier the obligations table knows (packages/core/lib/license/obligations.ts), a LicenseRef- this repository defines, or NOASSERTION.`
		)
	}
}
