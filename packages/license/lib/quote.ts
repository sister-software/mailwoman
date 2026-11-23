// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Whether a source's rows may be quoted verbatim in published text, and the one helper
 *   that prints a row or its id accordingly.
 *
 *   A receipt, a document or an error message that prints a row's text publishes that row.
 *   A decision can permit evaluating on a source's rows and refuse publishing them, so a writer of
 *   published text prints such a row by its id.
 */

import { type LicenseDecision, LicenseReviewState, OperationPermission, permissionFor } from "#decision"
import { SourceOperation } from "#operations"

/**
 * Whether a decision lets a source's rows be quoted verbatim in published text.
 *
 * A quote of a row publishes it, so the rows are quotable only when an elected
 * decision permits `distribute-rows`.
 * An absent, unchecked or refused decision, and one that refuses or leaves
 * `distribute-rows` unreviewed, reads `false`.
 */
export function rowsQuotable(decision: LicenseDecision<SourceOperation> | null | undefined): boolean {
	if (decision?.state !== LicenseReviewState.Elected) return false

	return permissionFor(decision, SourceOperation.DistributeRows).permission === OperationPermission.Permitted
}

/**
 * A row as published text prints it.
 */
export interface QuotableRow {
	/**
	 * The row's identifier, printed in place of its text when the row isn't quotable.
	 */
	id: string
	/**
	 * The row's verbatim text, such as a held-out row's raw address.
	 */
	text: string
	/**
	 * Whether the row's source lets it be quoted, as {@linkcode rowsQuotable} reads it.
	 */
	quotable: boolean
}

/**
 * The text published output prints for a row: its verbatim text when it is quotable, else `row <id>`.
 *
 * @public
 */
export function quoteRow(row: QuotableRow): string {
	return row.quotable ? row.text : `row ${row.id}`
}
