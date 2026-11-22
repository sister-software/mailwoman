// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The locale a command hands the parse pipeline as the caller's.
 */

/**
 * The pipeline's locale option for a command with a `--locale` flag: the flag's value
 * when the user typed it, and zero options otherwise.
 *
 * A pipeline records a locale it is handed as the caller's.
 * The flag's default is no one's choice, so without a typed flag the pipeline applies its own order:
 * `$MW_LOCALE`, then the input's script or postcode evidence, then the machine's locale.
 *
 * The command still loads its weights from the flag's value, default included.
 *
 * @param typed The flags the user typed, as `ParsedCommand.typed` states them.
 * @param locale The value of `--locale`.
 */
export function typedLocaleHint(typed: ReadonlySet<string>, locale: string): { locale?: string } {
	return typed.has("locale") ? { locale } : {}
}
