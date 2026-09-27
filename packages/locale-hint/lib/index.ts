// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Stage 2 locale detection using QueryShape scripts and known-format hits. Return the top candidate and alternatives
 *   from structural cues, without place-name dictionaries.
 */

export { detectLocale } from "#detect"
export { scoreByPostcode, scoreByScript, scoreFallback } from "#rules"
export type { LocaleCandidate } from "#rules"
export type { DetectLocaleOpts } from "#types"
