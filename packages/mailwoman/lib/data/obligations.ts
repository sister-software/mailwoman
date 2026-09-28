/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A customer's refusal of an obligation class, decided against a recorded license expression.
 *
 *   `mailwoman data pull --refuse share-alike` and the `MAILWOMAN_REFUSE_OBLIGATIONS` variable name the
 *   classes of obligation an installation declines to take on. The decision reads a bundle's recorded
 *   expression, or an artifact's own manifest once the artifact is on disk, through `summarizeLicense`,
 *   and reports the identifier that carries the refused class rather than the bundle alone, because the
 *   identifier is what a reader can look up.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { LicenseObligation, licenseIdentifiers, summarizeLicense } from "@mailwoman/core/license/obligations"

/**
 * The classes of obligation a customer can refuse.
 */
export const ObligationRefusal = {
	/**
	 * A grant requiring a derived database to carry the same terms, as ODbL and CC-BY-SA do.
	 */
	ShareAlike: "share-alike",
	/**
	 * An identifier whose obligations this repository has not recorded.
	 *
	 * The identifier carries unknown obligations rather than none.
	 */
	Unresolved: "unresolved",
} as const

export type ObligationRefusal = (typeof ObligationRefusal)[keyof typeof ObligationRefusal]

/**
 * Every refusal class, in the order help text lists them.
 */
export const OBLIGATION_REFUSALS: readonly ObligationRefusal[] = Object.values(ObligationRefusal)

function isObligationRefusal(value: string): value is ObligationRefusal {
	return (OBLIGATION_REFUSALS as readonly string[]).includes(value)
}

/**
 * Parse refusal classes from repeated flags or a comma-separated variable, refusing an unknown class.
 *
 * @throws When a value names no known class.
 */
export function parseObligationRefusals(values: readonly string[]): ObligationRefusal[] {
	const parsed: ObligationRefusal[] = []

	for (const value of values) {
		for (const part of value.split(",")) {
			const trimmed = part.trim()

			if (!trimmed) continue

			if (!isObligationRefusal(trimmed)) {
				throw new Error(
					`unknown obligation class ${stringifyJSON(trimmed)}; the classes are ${OBLIGATION_REFUSALS.join(", ")}`
				)
			}

			if (!parsed.includes(trimmed)) {
				parsed.push(trimmed)
			}
		}
	}

	return parsed
}

/**
 * One identifier in an expression that carries a refused class.
 */
export interface ObligationFinding {
	refusal: ObligationRefusal
	identifier: string
	reason: string
}

/**
 * Every identifier in `expression` that carries one of the refused classes.
 *
 * An empty list means no identifier carries a refused class.
 * It does not mean the expression was verified against the upstream terms.
 */
export function obligationFindings(expression: string, refuse: readonly ObligationRefusal[]): ObligationFinding[] {
	const findings: ObligationFinding[] = []

	for (const identifier of licenseIdentifiers(expression)) {
		const summary = summarizeLicense(identifier)

		if (refuse.includes(ObligationRefusal.ShareAlike) && summary.obligations.includes(LicenseObligation.ShareAlike)) {
			findings.push({
				refusal: ObligationRefusal.ShareAlike,
				identifier,
				reason: `${identifier} carries share-alike`,
			})
		}

		if (refuse.includes(ObligationRefusal.Unresolved) && !summary.recognized) {
			findings.push({
				refusal: ObligationRefusal.Unresolved,
				identifier,
				reason: `${identifier} resolves to no recorded obligations`,
			})
		}
	}

	return findings
}
