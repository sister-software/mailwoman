// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/activity-lexicon` — the reviewed surface forms for activity concepts.
 *
 *   The vocabulary lists the strings people type to refer to an activity. It also records where each string is
 *   used. `@mailwoman/geographic-model` records which entity kinds support an activity and in which countries.
 *   It also records the authority for each association. `@mailwoman/poi-taxonomy` records which venue nouns identify
 *   a POI category. A consumer joins these sources. Each source keeps its own information.
 */

export {
	ACTIVITY_LEXICON_PATH,
	auditActivityLexicon,
	normalizeActivityPhrase,
	readActivityLexicon,
	resolveActivityPhraseLocale,
} from "#lexicon"

export type * from "#types"
