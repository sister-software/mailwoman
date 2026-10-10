// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The result of a single check, produced by tooling and rendered by the command line.
 */

/**
 * One check-list entry.
 */
export interface Check {
	ok: boolean
	check: string
	detail?: string
}
