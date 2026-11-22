// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The acts this repository performs on an address source.
 *
 *   A license decision in the address-source register records a permission per operation.
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
 * so a release of it performs `commercial-sublicense` on every source behind it.
 *
 * `commercial-sublicense` is the act of licensing a result built from a source's rows,
 * trained weights or a served data layer, to a paying customer under `LicenseRef-Commercial`,
 * beside or in place of the open-source branch.
 * A source's decision permits it when its grant lets this repository license that result
 * on terms of its own, for a fee: CC BY 4.0 §1(b) and §3(a)(4) let an adapter license
 * Adapted Material under its own Adapter's License, and OGL v3.0 and Licence Ouverte
 * 2.0 grant commercial exploitation `in your own product or application`.
 *
 * A grant refuses it when it limits use to non-commercial purposes, forbids sale
 * or resale, or forbids terms on the result.
 *
 * The act passes on no license to the source's own rows.
 * Under CC BY 4.0 §2(a)(5)(A), CC BY 3.0 AU clause 9, OGL v3.0 and Licence Ouverte 2.0
 * a recipient takes the source's grant from its licensor directly, so the commercial
 * terms add to that grant and never restrict it (CC BY 4.0 §2(a)(5)(B)).
 *
 * A grant's `non-sublicensable` clause therefore refuses an act this repository
 * doesn't perform and doesn't refuse this one.
 */
export function soldUnderCommercialTerms(expression: string): boolean {
	return licenseIdentifiers(expression).some((identifier) => licenseWithoutException(identifier) === COMMERCIAL_TERMS)
}

/**
 * The acts this repository performs on a source, in pipeline order.
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
	 * Model fitting on the transformed rows.
	 */
	Train: "train",
	/**
	 * Redistribution of raw or transformed rows as a database, lexicon or index.
	 */
	RedistributeData: "redistribute-data",
	/**
	 * Redistribution of weights trained on the rows.
	 */
	RedistributeModel: "redistribute-model",
	/**
	 * A paying customer receives a license, under `LicenseRef-Commercial`, to a result
	 * built from the rows: trained weights or a served data layer.
	 *
	 * It passes on no license to the rows themselves. {@linkcode soldUnderCommercialTerms}
	 * states the definition and the grants that permit it.
	 */
	CommercialSublicense: "commercial-sublicense",
} as const

/**
 * One of the {@link SourceOperation} values.
 */
export type SourceOperation = (typeof SourceOperation)[keyof typeof SourceOperation]
