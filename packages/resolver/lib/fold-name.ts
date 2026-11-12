// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   One shared name fold for the resolver's commune reconciliation, the street
 *   tier's locality comparison and span-rescore's key guards.
 *
 *   Its own module because those would otherwise import each other for it.
 */

/**
 * Case/diacritic-insensitive fold for commune-name comparison: marks are deleted, never spaced,
 * so `Besançon` doesn't key as `besanc on`; a letter with no decomposition is dropped rather than folded.
 */
export function foldName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/\p{M}/gu, "")
		.replaceAll(/[^a-z0-9 ]/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim()
}
