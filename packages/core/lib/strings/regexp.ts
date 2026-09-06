// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Regular-expression string helpers.
 */

/**
 * `literal` escaped so that `new RegExp(escapeRegExp(literal))` matches it verbatim.
 */
export function escapeRegExp(literal: string): string {
	return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
