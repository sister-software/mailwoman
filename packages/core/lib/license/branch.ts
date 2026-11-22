// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Which branch of Mailwoman's own dual license applies to an installation.
 *
 *   The obligations of a third-party source's license are `@mailwoman/license/obligations`.
 *   This module decides only between the AGPL branch and the commercial branch of the product license.
 */

import { ExpressionOperator, licenseExpressionTerms } from "@mailwoman/license/expression"

import type { LicenseKeyVerification } from "#license/key"
import type { LicenseKeyPublication } from "#license/publication"

/**
 * Returns whether a verification grants the commercial branch: the token is valid
 * and its terms are commercial.
 *
 * A valid open-source token answers false, so the AGPL branch and its notice stay in place for it.
 * The function lives here rather than in `key.ts` because this module sits in the
 * docs site's plugin graph that jiti evaluates.
 *
 * A value import of `key.ts` would pull its zod schema into that graph.
 */
export function grantsCommercialTerms(key: LicenseKeyVerification | null | undefined): boolean {
	return key?.status === "valid" && key.payload.terms === "LicenseRef-Commercial"
}

/**
 * Returns the branch of mailwoman's license expression that applies to this installation.
 *
 * The commercial branch applies only when the key is `valid` and the published
 * key register hasn't marked it retired or unlisted.
 * The doctor passes both the key and the register status.
 * The stamp runs offline and passes only the key.
 */
export function appliedLicenseBranch(
	expression: string,
	key?: LicenseKeyVerification,
	publication?: LicenseKeyPublication
): string {
	const retired = publication === "retired" || publication === "unlisted"

	return chooseLicenseBranch(expression, { commercialAgreement: grantsCommercialTerms(key) && !retired })
}

/**
 * Chooses the applicable branch of an `A OR B` expression.
 *
 * The first `LicenseRef-` branch applies when there's a commercial agreement.
 * Otherwise the first open-source branch applies.
 * An expression without `OR` is returned unchanged.
 */
export function chooseLicenseBranch(expression: string, options: { commercialAgreement: boolean }): string {
	const branches = licenseExpressionTerms(expression, [ExpressionOperator.Or])

	if (branches.length < 2) return expression

	const commercial = branches.find((branch) => branch.startsWith("LicenseRef-"))
	const open = branches.find((branch) => !branch.startsWith("LicenseRef-"))

	if (options.commercialAgreement && commercial) return commercial

	return open ?? branches[0]!
}
