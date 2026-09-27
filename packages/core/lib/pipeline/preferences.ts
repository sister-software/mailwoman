// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Runtime pipeline host preferences.
 */

/**
 * Independent host/browser preferences.
 *
 * A timezone is evidence, never a locale conversion.
 */
export interface MachinePreferences {
	locale?: Intl.UnicodeBCP47LocaleIdentifier
	timeZone?: string
}
