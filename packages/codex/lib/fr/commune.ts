// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   French commune name casing.
 */

import { titleCase } from "spliterator/casing"

/**
 * These particles stay lowercase inside a commune name: `Saint-Jean-de-Luz`, `Méry-sur-Oise`.
 *
 * A leading particle isn't a joiner and is capitalized (`Le Mans`).
 */
export const FR_COMMUNE_PARTICLES: ReadonlySet<string> = new Set([
	"le",
	"la",
	"les",
	"de",
	"du",
	"des",
	"d",
	"l",
	"sur",
	"sous",
	"en",
	"aux",
	"au",
	"et",
	"lez",
])

/**
 * Titlecases a French commune name, keeping {@link FR_COMMUNE_PARTICLES} lowercase after the first word.
 * Hyphenated parts are cased individually.
 */
export function titleCaseFR(value: string): string {
	return titleCase(value, { particles: FR_COMMUNE_PARTICLES })
}
