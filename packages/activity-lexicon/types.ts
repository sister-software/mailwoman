/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the reviewed activity-phrase lexicon.
 *
 *   AN ENTRY DECLARES A SURFACE FORM AND NOTHING ELSE. The phrase is what a person types; the activity is a concept
 *   identifier some other artifact owns. Which entity kinds afford that activity, in which country, with what modality
 *   and on whose authority are not stated here and cannot be — this vocabulary is recognition, and a consumer that
 *   wants the semantics reads the artifact that carries them.
 *
 *   EVERY ENTRY NAMES WHAT ATTESTS IT. {@linkcode ActivityPhraseAttestation} is a discriminated union rather than a
 *   free-text field because an attestation nobody can check is indistinguishable from an invented one: each member
 *   points at something committed — a query row, another entry in this lexicon, a synonym in a committed vocabulary,
 *   or a clause of the activity concept's own description — and names the exact text it rests on.
 */

/**
 * Where a record came from. Field-for-field the shape `@mailwoman/geographic-model` uses for its own provenance, so a
 * consumer carrying both never has to translate between two spellings of the same idea. It is restated rather than
 * imported because this package declares zero dependencies.
 */
export interface ActivityLexiconProvenance {
	/**
	 * The naming authority, dataset, publication, or curator.
	 */
	source: string
	sourceVersion?: string
	/**
	 * The identifier of the specific record within the source.
	 */
	sourceRecord?: string
	sourceURL?: string
	/**
	 * ISO 8601 calendar date the record was authored, `YYYY-MM-DD`.
	 */
	authoredAt?: string
	notes?: string
}

/**
 * The phrase is the subject of a query committed to this repository. The strongest attestation available: the form was
 * written down for grading before it was written down for recognition.
 */
export interface CommittedQueryAttestation {
	kind: "committed-query"
	/**
	 * `<repository-relative file>#<row id>`.
	 */
	reference: string
	/**
	 * The committed query verbatim. A reader can grep for it; a test can require the phrase to end it.
	 */
	detail: string
}

/**
 * Which regular transformation produced a derived form. Deliberately closed: an open list would let any pair of strings
 * be declared related.
 */
export type ActivityPhraseDerivation = "plural" | "nominalization" | "verb-phrase" | "possessive"

/**
 * The phrase is a regular transformation of another entry in this lexicon. The base carries the authority; the
 * derivation names the transformation.
 */
export interface DerivedFormAttestation {
	kind: "derived-form"
	/**
	 * Another entry's `phrase`. The base may not itself be derived — an attestation chain that never reaches a committed
	 * record attests nothing.
	 */
	base: string
	derivation: ActivityPhraseDerivation
}

/**
 * The phrase is the regional-register counterpart of another entry, and the register split it follows is recorded in a
 * committed vocabulary rather than asserted here.
 */
export interface RegionalRegisterAttestation {
	kind: "regional-register"
	/**
	 * The committed record that carries the register split, e.g. a `@mailwoman/poi-taxonomy` synonym phrase.
	 */
	reference: string
	/**
	 * The entry whose register this one mirrors.
	 */
	base: string
	/**
	 * The locales the referenced record carries, written out so a reader sees what the entry's own `locales` are copied
	 * from.
	 */
	detail: string
}

/**
 * The phrase paraphrases a clause of the activity concept's own description. The clause is quoted so the citation can
 * be checked against the compiled artifact rather than believed.
 */
export interface ConceptDescriptionAttestation {
	kind: "concept-description"
	/**
	 * The concept identifier whose description is cited — the entry's own `activity`.
	 */
	reference: string
	/**
	 * The exact substring of that concept's description the phrase rests on.
	 */
	detail: string
}

export type ActivityPhraseAttestation =
	| CommittedQueryAttestation
	| DerivedFormAttestation
	| RegionalRegisterAttestation
	| ConceptDescriptionAttestation

/**
 * One reviewed surface form.
 */
export interface ActivityPhraseEntry {
	/**
	 * The text a person types, as a reader would write it. Comparison is done over the normalized form.
	 */
	phrase: string
	/**
	 * A concept identifier of kind `activity`, owned by whichever artifact the consumer resolves against. This lexicon
	 * neither defines the concept nor claims anything about it.
	 */
	activity: string
	/**
	 * BCP-47 tags where the phrasing is in active use, following the `@mailwoman/variant-aliases` semantics: an exact tag
	 * match is a full match, a language-only match is a weaker one, and nothing else matches.
	 *
	 * ABSENT MEANS UNSCOPED, and is not the same as an empty list: a phrase used everywhere carries no tags, while a
	 * phrase scoped to nowhere is a record that can never fire, which the audit refuses.
	 */
	locales?: ReadonlyArray<string>
	/**
	 * How the entry was produced. `curated` is the only admissible value: a phrase mined from traffic would be a
	 * measurement, and this vocabulary carries none.
	 */
	source: "curated"
	attestation: ActivityPhraseAttestation
	/**
	 * Why the entry is in the lexicon, for a reader deciding whether it still belongs.
	 */
	note: string
}

/**
 * The committed lexicon.
 */
export interface ActivityPhraseLexicon {
	lexiconID: string
	version: string
	provenance: ActivityLexiconProvenance
	phrases: ActivityPhraseEntry[]
}

/**
 * How an entry's locale scope met the locale a query was read under.
 *
 * - `unscoped` — the entry declares no locales and answers under any.
 * - `exact` — the query's locale tag is one the entry declares.
 * - `language` — only the language subtag agrees. Weaker on purpose: a regional phrasing reached through its language
 *   alone is a guess about the region.
 */
export type ActivityPhraseLocaleScope = "unscoped" | "exact" | "language"

/**
 * One entry matched under one locale.
 */
export interface ActivityPhraseLocaleMatch {
	scope: ActivityPhraseLocaleScope
	/**
	 * `1` for `unscoped` and `exact`, `0.5` for `language` — the numbers `@mailwoman/variant-aliases` reports for the
	 * same three cases, carried over rather than chosen here.
	 */
	confidence: number
}
