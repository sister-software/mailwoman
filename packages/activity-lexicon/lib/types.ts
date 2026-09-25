/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the reviewed activity-phrase lexicon.
 */

/**
 * Where a record came from.
 *
 * The shape matches the provenance type in `@mailwoman/geographic-model`.
 * It is copied because this package does not depend on that one.
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
	 * ISO 8601 calendar date the record was authored, `yyyy-MM-DD`.
	 */
	authoredAt?: string
	notes?: string
}

/**
 * Attestation for a phrase that appears in a query committed to this repository.
 */
export interface CommittedQueryAttestation {
	kind: "committed-query"
	/**
	 * `<repository-relative file>#<row id>`.
	 */
	reference: string
	/**
	 * The committed query, copied exactly.
	 */
	detail: string
}

/**
 * Regular transformation that produced a derived form.
 *
 * The list is closed so that an entry cannot declare an arbitrary pair of strings related.
 */
export type ActivityPhraseDerivation = "plural" | "nominalization" | "verb-phrase" | "possessive"

/**
 * Attestation for a phrase that is a regular transformation of another entry.
 *
 * The base entry supplies the evidence.
 */
export interface DerivedFormAttestation {
	kind: "derived-form"
	/**
	 * Another entry's `phrase`.
	 * The base entry must not itself be derived.
	 */
	base: string
	derivation: ActivityPhraseDerivation
}

/**
 * Attestation for a regional variant of another entry.
 *
 * A committed vocabulary must record the regional split.
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
	 * The locales of the referenced record, which the entry's `locales` copy.
	 */
	detail: string
}

/**
 * Attestation for a phrase that paraphrases part of the activity concept's description.
 *
 * The quoted clause lets a check verify the citation against the compiled artifact.
 */
export interface ConceptDescriptionAttestation {
	kind: "concept-description"
	/**
	 * The cited concept identifier, which equals the entry's `activity`.
	 */
	reference: string
	/**
	 * The exact substring of the concept's description that the phrase paraphrases.
	 */
	detail: string
}

/**
 * Evidence that justifies an entry.
 */
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
	 * The text a person types.
	 * Matching compares normalized forms.
	 */
	phrase: string
	/**
	 * A concept identifier of kind `activity`.
	 * The artifact the consumer resolves against defines it.
	 */
	activity: string
	/**
	 * BCP-47 tags where the phrasing is in use, with `@mailwoman/variant-aliases` matching rules.
	 *
	 * An absent field means the phrase applies everywhere.
	 * The audit rejects an empty list because such an entry could never match.
	 */
	locales?: ReadonlyArray<Intl.UnicodeBCP47LocaleIdentifier>
	/**
	 * How the entry was produced.
	 * Only curated entries are allowed.
	 */
	source: "curated"
	attestation: ActivityPhraseAttestation
	/**
	 * Why the entry belongs in the lexicon.
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
 * How an entry's locales matched the query locale.
 *
 * - `unscoped`: the entry declares no locales and matches any locale.
 * - `exact`: the entry declares the query's locale tag.
 * - `language`: only the language subtag matches, which is weaker evidence for a regional phrase.
 */
export type ActivityPhraseLocaleScope = "unscoped" | "exact" | "language"

/**
 * One entry matched under one locale.
 */
export interface ActivityPhraseLocaleMatch {
	scope: ActivityPhraseLocaleScope
	/**
	 * `1` for `unscoped` and `exact`, `0.5` for `language`.
	 * These values match `@mailwoman/variant-aliases`.
	 */
	confidence: number
}
