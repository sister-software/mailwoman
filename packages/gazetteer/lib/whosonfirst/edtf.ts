// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Readers of a Who's On First record's EDTF date properties, such as `edtf:deprecated` and `edtf:cessation`.
 */

/**
 * Whether a value starts with a digit, the test that marks a record deprecated or ceased.
 *
 * Who's On First writes `"uuuu"`, EDTF's unknown date, and `""` on current records,
 * so either value leaves the record current.
 */
export function isEDTFDate(value: unknown): value is string {
	return typeof value === "string" && /^\d/.test(value)
}
