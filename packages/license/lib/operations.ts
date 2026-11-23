// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The acts this repository performs on an address source.
 *
 *   A license decision in the address-source register records a permission per operation,
 *   and a permission per purpose (`UsePurpose` in `#decision`).
 *   The action table in `#actions` states which operations each build or release performs.
 */

import { licenseWithoutException } from "#expression"
import { licenseIdentifiers } from "#obligations"

/**
 * The identifier of Mailwoman's commercial terms (`commercial-LICENSE.md`).
 */
const COMMERCIAL_TERMS = "LicenseRef-Commercial"

/**
 * Whether an artifact's license expression offers it under Mailwoman's commercial terms,
 * so an act that delivers it performs the `sale` purpose on every source behind it.
 *
 * A `sale` is the licensing of a result built from a source's rows, trained weights
 * or a served data layer, to a paying customer under `LicenseRef-Commercial`,
 * beside or in place of the open-source branch.
 * A source's decision permits it when its grant lets this repository license that result
 * on terms of its own, for a fee: CC BY 4.0 §1(b) and §3(a)(4) let an adapter license
 * Adapted Material under its own Adapter's License, and OGL v3.0 and Licence Ouverte
 * 2.0 grant commercial exploitation `in your own product or application`.
 *
 * A grant refuses it when it limits use to non-commercial purposes, forbids sale
 * or resale, or forbids terms on the result.
 *
 * A sale passes on no license to the source's own rows.
 * Under CC BY 4.0 §2(a)(5)(A), CC BY 3.0 AU clause 9, OGL v3.0 and Licence Ouverte 2.0
 * a recipient takes the source's grant from its licensor directly, so the commercial
 * terms add to that grant and never restrict it (CC BY 4.0 §2(a)(5)(B)).
 *
 * A grant's `non-sublicensable` clause therefore refuses {@linkcode SourceOperation.Sublicense},
 * an act this repository doesn't perform, and doesn't refuse a sale.
 */
export function soldUnderCommercialTerms(expression: string): boolean {
	return licenseIdentifiers(expression).some((identifier) => licenseWithoutException(identifier) === COMMERCIAL_TERMS)
}

/**
 * The acts this repository performs on a source, in pipeline order.
 * Each name states what leaves this repository's hands.
 *
 * A grant can permit some and stay silent on others, so license decisions record a permission per operation.
 */
export const SourceOperation = {
	/**
	 * Bulk copy of the published dataset into `$MAILWOMAN_DATA_ROOT`.
	 */
	Fetch: "fetch",
	/**
	 * Postal-address extraction from the copied file.
	 */
	Extract: "extract",
	/**
	 * Transformation of extracted rows into a token and tag corpus.
	 */
	Transform: "transform",
	/**
	 * A model scored on the transformed rows.
	 * No weight is fitted, and only aggregate scores leave.
	 */
	Evaluate: "evaluate",
	/**
	 * Model fitting on the transformed rows.
	 */
	Train: "train",
	/**
	 * A file from which the rows can be read back leaves: a database, a dataset or tiles.
	 */
	DistributeRows: "distribute-rows",
	/**
	 * Values drawn from the rows leave one request at a time, and the file stays.
	 */
	AnswerQueries: "answer-queries",
	/**
	 * An artifact computed from the rows leaves, and the rows can't be recovered from it:
	 * an FST, a lexicon or centroids.
	 */
	DistributeDerived: "distribute-derived",
	/**
	 * Weights fitted on the rows leave.
	 */
	DistributeModel: "distribute-model",
	/**
	 * A recipient is granted a license to the source's own rows.
	 *
	 * No action performs it: a sale licenses a result built from the rows,
	 * and {@linkcode soldUnderCommercialTerms} states why that's a different act.
	 */
	Sublicense: "sublicense",
} as const

/**
 * One of the {@link SourceOperation} values.
 */
export type SourceOperation = (typeof SourceOperation)[keyof typeof SourceOperation]
