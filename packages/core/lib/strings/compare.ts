// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file String comparators.
 */

/**
 * A locale-independent string order for `Array.prototype.sort`.
 *
 * `localeCompare` answers differently under different ICU builds, so an artifact sorted with it is not reproducible
 * across machines. code-point order is.
 */
export function compareByCodePoint(left: string, right: string): number {
	if (left < right) return -1

	if (left > right) return 1

	return 0
}
