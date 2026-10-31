/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A customer's refusal of an obligation class, decided against a recorded license expression.
 *
 *   `mailwoman data pull --refuse share-alike` and the `MAILWOMAN_REFUSE_OBLIGATIONS` variable name the
 *   classes of obligation an installation declines to take on. The decision reads a bundle's recorded
 *   expression, or an artifact's manifest once the artifact is on disk, through `summarizeLicense`.
 *   It reports the identifier with the refused class so a reader can look it up.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { LayerManifest } from "@mailwoman/core/layers"
import { LicenseObligation, licenseIdentifiers, summarizeLicense } from "@mailwoman/core/license/obligations"

/**
 * The classes of obligation a customer can refuse.
 */
export const ObligationRefusal = {
	/**
	 * A grant requiring a derived database to use the same terms, as ODbL and CC-BY-SA do.
	 */
	ShareAlike: "share-alike",
	/**
	 * An identifier whose obligations this repository has not recorded.
	 *
	 * The repository has not recorded the identifier's obligations.
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
 * One identifier in an expression with a refused class.
 */
export interface ObligationFinding {
	refusal: ObligationRefusal
	identifier: string
	reason: string
}

/**
 * Every identifier in `expression` with one of the refused classes.
 *
 * An empty list means no identifier has a refused class.
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

/**
 * Throws when a layer's recorded license includes a refused obligation class.
 *
 * The message repeats the layer's provenance as its manifest records it: name,
 * license, credit, source, input URL and digest.
 * A refused layer therefore reports what it is and where it came from, and the operator
 * can remove it or change the refusal knowing which data is in question.
 *
 * @throws When {@link obligationFindings} finds a refused class in the manifest's license.
 */
export function assertLayerObligationsAccepted(
	manifest: LayerManifest,
	path: string,
	refuse: readonly ObligationRefusal[]
): void {
	const findings = obligationFindings(manifest.license, refuse)

	if (!findings.length) return

	const provenance = [
		`layer ${manifest.name} at ${path}`,
		`license ${manifest.license}`,
		`credit ${manifest.attribution ?? "unrecorded"}`,
		`source ${manifest.source} (${manifest.sourceVintage})`,
		`input ${manifest.sourceURL ?? "unrecorded"} sha256 ${manifest.sourceSHA256 ?? "unrecorded"}`,
	]

	throw new Error(
		`MAILWOMAN_REFUSE_OBLIGATIONS refuses ${findings.map((finding) => finding.reason).join("; ")}. ` +
			`The session will not attach ${provenance.join(", ")}. ` +
			"Remove the database, or drop the class from MAILWOMAN_REFUSE_OBLIGATIONS."
	)
}
