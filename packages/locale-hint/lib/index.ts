// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/locale-hint` — Stage 2 of the runtime pipeline.
 *
 *   Rule-based locale detection from `QueryShape`'s script + known-format hits. Returns a
 *   `LocaleHint` with the top candidate + alternatives, surfacing detector disagreement when the
 *   caller's `--locale` hint differs from what the input shape implies.
 *
 *   Bitter-lesson-safe: only universal structural cues (script, postcode patterns), no place-name
 *   dictionaries. Trained character-level model is a v0.6.0 follow-on.
 *
 *   See `docs/engineering/reference/STAGES.md` § Stage 2 for the contract.
 */

export { detectLocale, detectLocaleSync } from "#detect"
export { scoreByPostcode, scoreByScript, scoreFallback } from "#rules"
export type { LocaleCandidate } from "#rules"

export type {
	DetectLocaleOpts,
	LocaleHint,
	LocaleTag,
	MachinePreferences,
	NormalizedInputLite,
	QueryShapeLike,
} from "#types"
