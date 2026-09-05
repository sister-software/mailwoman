/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The obligations a license places on the party running mailwoman, summarized from an SPDX expression. This is a
 *   debugging summary for `mailwoman doctor`, not legal advice: it names the responsibility class each identifier is
 *   known to carry, and it says `recognized: false` for an identifier it does not know rather than guessing.
 */

/**
 * The responsibility classes the summary reports.
 *
 * - `attribution`: credit the source where results derived from it are shown or redistributed.
 * - `share_alike`: a derived work or derived database carries the same license (ODbL's Derived Database; AGPL's copyleft
 *   on modifications).
 * - `source_offer`: users who interact with the software over a network must be offered its source, including
 *   modifications (AGPL-3.0 section 13).
 */
export const LicenseObligation = {
	Attribution: "attribution",
	ShareAlike: "share_alike",
	SourceOffer: "source_offer",
} as const

export type LicenseObligation = (typeof LicenseObligation)[keyof typeof LicenseObligation]

/**
 * What one SPDX identifier is known to require. An identifier absent from this table is UNRECOGNIZED, which the summary
 * reports as such — the meaning-of-zero rule: an empty obligation list is a statement, and an unknown license must not
 * read as one.
 */
const KNOWN_OBLIGATIONS: ReadonlyMap<string, readonly LicenseObligation[]> = new Map<
	string,
	readonly LicenseObligation[]
>([
	["AGPL-3.0-only", [LicenseObligation.Attribution, LicenseObligation.ShareAlike, LicenseObligation.SourceOffer]],
	["AGPL-3.0-or-later", [LicenseObligation.Attribution, LicenseObligation.ShareAlike, LicenseObligation.SourceOffer]],
	// The commercial agreement's attribution clause (COMMERCIAL-LICENSE.md, section 4).
	["LicenseRef-Commercial", [LicenseObligation.Attribution]],
	["ODbL-1.0", [LicenseObligation.Attribution, LicenseObligation.ShareAlike]],
	["OGL-UK-3.0", [LicenseObligation.Attribution]],
	["CDLA-Permissive-2.0", [LicenseObligation.Attribution]],
	["CC-BY-4.0", [LicenseObligation.Attribution]],
	["CC0-1.0", []],
	["PDDL-1.0", []],
	// A work of the United States Government (17 U.S.C. § 105): no copyright, so no obligation. SPDX has no identifier
	// for it; the `LicenseRef` is defined in docs/engineering/reference/layer-contract.mdx.
	["LicenseRef-USGov-Public-Domain", []],
	// Licence Ouverte 2.0 (etalab), BAN's elected license.
	["etalab-2.0", [LicenseObligation.Attribution]],
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
	 * The identifiers the expression names, in order. `AGPL-3.0-only OR LicenseRef-Commercial` names two.
	 */
	identifiers: string[]
	/**
	 * The union of the known obligations across every identifier — the conservative reading of an `AND`, and for an `OR`
	 * the reading before a party has chosen a branch (see {@link chooseLicenseBranch}).
	 */
	obligations: LicenseObligation[]
	/**
	 * True when every identifier is in the known table. `NOASSERTION`, a vendor-suffixed identifier such as
	 * `PDDL-1.0-USGov-NRCS`, or a misspelling all read false.
	 */
	recognized: boolean
	/**
	 * The identifiers that were not recognized, so the report can name them.
	 */
	unrecognized: string[]
}

/**
 * Split an SPDX expression into its identifiers. Handles `AND`, `OR`, `WITH` (the exception is kept with its license)
 * and parentheses; anything more exotic still splits on the operators, which is enough for a summary that reports what
 * it did not recognize.
 */
export function licenseIdentifiers(expression: string): string[] {
	return expression
		.replaceAll(/[()]/g, " ")
		.split(/\s+(?:AND|OR)\s+/i)
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
}

/**
 * Summarize an SPDX expression into the obligations it is known to carry.
 */
export function summarizeLicense(expression: string): LicenseSummary {
	const identifiers = licenseIdentifiers(expression)
	const obligations = new Set<LicenseObligation>()
	const unrecognized: string[] = []

	for (const identifier of identifiers) {
		const known = KNOWN_OBLIGATIONS.get(identifier.split(/\s+WITH\s+/i)[0]!)

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
 * Choose the branch of a dual-licensed (`A OR B`) expression that applies to this installation. Mailwoman's own
 * expression is `AGPL-3.0-only OR LicenseRef-Commercial`: without a commercial agreement the open-source branch
 * applies, and the summary reports its obligations rather than the union. An expression with no `OR` is returned
 * whole.
 */
export function chooseLicenseBranch(expression: string, options: { commercialAgreement: boolean }): string {
	const branches = expression
		.replaceAll(/[()]/g, " ")
		.split(/\s+OR\s+/i)
		.map((part) => part.trim())
		.filter((part) => part.length > 0)

	if (branches.length < 2) return expression

	const commercial = branches.find((branch) => branch.startsWith("LicenseRef-"))
	const open = branches.find((branch) => !branch.startsWith("LicenseRef-"))

	if (options.commercialAgreement && commercial) return commercial

	return open ?? branches[0]!
}

const LICENSE_REF = /^LicenseRef-[A-Za-z0-9.-]+$/u

/**
 * Whether an SPDX expression may be RECORDED in a layer manifest: every identifier is one the obligations table knows,
 * a `LicenseRef-…` this repository defines, or `NOASSERTION` (the publisher has stated no license; the doctor reports
 * that as degraded, which is the correct reading). Anything else is refused at build time, because a manifest is sealed
 * data and a vendor-suffixed identifier such as `PDDL-1.0-USGov-NRCS` would otherwise ship and read as unrecognized on
 * every machine that opens it.
 */
export function assertAdmissibleLicenseExpression(expression: string, context = "license"): void {
	for (const identifier of licenseIdentifiers(expression)) {
		if (identifier === "NOASSERTION" || KNOWN_OBLIGATIONS.has(identifier) || LICENSE_REF.test(identifier)) continue

		throw new Error(
			`${context}: ${JSON.stringify(identifier)} is not an admissible license identifier. Use the SPDX identifier the obligations table knows (packages/core/lib/license/obligations.ts), a LicenseRef- this repository defines, or NOASSERTION.`
		)
	}
}
