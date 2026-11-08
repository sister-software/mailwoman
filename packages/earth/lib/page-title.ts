// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The document title: the app's name on its own, or the matched place's name before it, so a tab and a
 *   history entry read as the place they show.
 */

/**
 * The app's name, as `index.html` sets it before any match.
 */
export const APP_TITLE = "Mailwoman Earth"

/**
 * The title for a page that shows `subject`, or the app's name for a page that shows no match.
 */
export function pageTitle(subject: string | null): string {
	const trimmed = subject?.trim()

	return trimmed ? `${trimmed} · ${APP_TITLE}` : APP_TITLE
}
