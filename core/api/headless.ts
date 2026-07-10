// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Headless browser utilities.
 */

/**
 * Common user agent strings.
 */
export const UserAgent = {
	/**
	 * IPad OS 13.0 Safari.
	 */
	iPadSafari:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15",
} as const

/**
 * Common user agent strings.
 */
export type UserAgent = (typeof UserAgent)[keyof typeof UserAgent]
