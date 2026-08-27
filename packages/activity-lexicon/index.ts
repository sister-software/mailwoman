/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/activity-lexicon` — the reviewed surface forms for activity concepts.
 *
 *   The vocabulary answers one question: which strings does a person type when they mean a given activity, and where
 *   is each of those strings used. It answers no question about the world. Which entity kinds afford the activity, in
 *   which country and on whose authority live in `@mailwoman/geographic-model`; which venue nouns name a POI category
 *   live in `@mailwoman/poi-taxonomy`. A consumer joins them; none of the three restates another.
 */

export {
	ACTIVITY_LEXICON_PATH,
	auditActivityLexicon,
	normalizeActivityPhrase,
	readActivityLexicon,
	resolveActivityPhraseLocale,
} from "./lexicon.ts"

export type * from "./types.ts"
