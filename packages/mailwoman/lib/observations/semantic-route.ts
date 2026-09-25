/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolves activity phrases to POI categories through the compiled geographic model.
 *
 *   The activity lexicon supplies the phrases. The model supplies `affords` assertions and the
 *   mappings into POI categories. The route returns every reachable category without ranking them
 *   and records an observation for each.
 */

import {
	type ActivityPhraseEntry,
	type ActivityPhraseLexicon,
	type ActivityPhraseLocaleMatch,
	type ActivityPhraseLocaleScope,
	auditActivityLexicon,
	normalizeActivityPhrase,
	readActivityLexicon,
	resolveActivityPhraseLocale,
} from "@mailwoman/activity-lexicon"
import { stringifyJSON } from "@mailwoman/core/json"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import type {
	CompiledGeographicModel,
	ConceptRecord,
	ExternalMappingRecord,
	RelationAssertion,
	SourceProvenance,
} from "@mailwoman/geographic-model"
import type { POIPhraseLookup, POIPhraseMatch } from "@mailwoman/kind-classifier"

import { localeToCountry } from "#country-scope"
import { readCommittedModel } from "#observations/committed-model"

/**
 * The only relation this route reads.
 *
 * Construction fails when the model does not define it, so a missing relation is
 * never reported as "nothing affords this activity".
 */
const AFFORDS_RELATION = "affords"

/**
 * The external vocabulary that a mapping must target for the POI executor to search it.
 */
const POI_TAXONOMY_VOCABULARY = "poi-taxonomy"

/**
 * One firing of the route, recorded beside the answer.
 *
 * It holds the provenance of each link from the phrase to the POI category: the lexicon entry
 * and its attestation, the activity, the concept's `affords` assertion, and the external mapping.
 */
export interface SemanticObservation {
	/**
	 * The candidate subject phrase passed to the lookup by `matchPOISubject`.
	 */
	phrase: string
	/**
	 * The declared lexicon phrase that matched.
	 */
	matchedPhrase: string
	phraseLexiconID: string
	phraseLexiconVersion: string
	phraseProvenance: SourceProvenance
	/**
	 * The record that attests the phrase itself.
	 *
	 * The assertion's provenance explains why a concept affords the activity.
	 * This field explains why the phrase refers to the activity.
	 */
	phraseAttestation: {
		kind: string
		reference: string
	}
	/**
	 * How the entry's locale scope matched the query's locale.
	 */
	localeScope: ActivityPhraseLocaleScope
	/**
	 * The locale tags that the entry declares, or `null` when the entry is unscoped.
	 */
	declaredLocales: string[] | null
	/**
	 * The country from the caller's locale, or `null`.
	 *
	 * The assertion's country scope is tested against the resolved anchor's country instead.
	 * The POI intent stage binds that country later and reports it on the intent's `countryBinding`.
	 */
	localeCountry: string | null
	activity: string
	concept: string
	assertion: {
		id: string
		relation: string
		modality: string
		/**
		 * The countries that the assertion is scoped to, or `null` when it is unscoped.
		 */
		countries: string[] | null
		provenance: SourceProvenance
	}
	mapping: {
		id: string
		vocabulary: string
		externalID: string
		provenance: SourceProvenance
	}
	/**
	 * The POI category ID returned to the pipeline, equal to the mapping's `externalID`.
	 */
	categoryID: string
	/**
	 * The number of mapped entity kinds that the activity reached on this firing.
	 *
	 * Each reached kind gets its own observation, and all of them carry the same count.
	 */
	mappedKindCount: number
	modelVersion: string
}

/**
 * Identifies the model and lexicon a route was built from, and the categories it can reach.
 *
 * Receipts record it so that a run with the route can be told apart from a run
 * where the route was silently missing.
 */
export interface SemanticRouteIdentity {
	phraseLexiconID: string
	phraseLexiconVersion: string
	declaredPhrases: number
	modelVersion: string
	/**
	 * Every POI category ID that the declared activities can reach, in code-point order.
	 */
	reachableCategoryIDs: string[]
}

/**
 * A semantic observation route that the pipeline receives as a POI phrase lookup.
 */
export interface SemanticObservationRoute {
	/**
	 * Matches a phrase against the lexicon.
	 *
	 * @returns `[]` for a phrase that does not end in a declared phrase admitted by the locale.
	 */
	lookup: POIPhraseLookup
	identity: SemanticRouteIdentity
	/**
	 * Returns the observations recorded since the last call, deduplicated, and clears them.
	 *
	 * One query calls the lookup several times over the input and its anchor prefixes,
	 * so the raw record repeats the same observation.
	 */
	takeObservations: () => SemanticObservation[]
}

/**
 * Options for {@link createSemanticObservationRoute}.
 */
export interface SemanticObservationRouteOptions {
	/**
	 * A compiled model to use in place of the committed one, such as a synthetic test model.
	 */
	model?: CompiledGeographicModel
	/**
	 * A lexicon to use in place of the committed one.
	 */
	lexicon?: ActivityPhraseLexicon
}

/**
 * One declared phrase with the categories it can reach.
 */
interface ResolvedPhrase {
	entry: ActivityPhraseEntry
	normalized: string
	reached: ReachedKind[]
}

/**
 * One entity kind that affords a declared activity, with the mapping that makes it searchable.
 */
interface ReachedKind {
	concept: ConceptRecord
	assertion: RelationAssertion
	mapping: ExternalMappingRecord
}

/**
 * Returns the entity kinds that assert `affords` for the activity and map into a POI category.
 *
 * The result is sorted by concept ID for stability only.
 * The POI branch searches the union of all kinds.
 *
 * Country scope is applied later by the intent stage, after the anchor's country is known.
 */
function reachKinds(model: CompiledGeographicModel, activity: string): ReachedKind[] {
	const mappings = new Map<string, ExternalMappingRecord>()

	for (const mapping of model.mappings) {
		if (mapping.vocabulary !== POI_TAXONOMY_VOCABULARY) continue

		mappings.set(String(mapping.concept), mapping)
	}

	const reached: ReachedKind[] = []

	for (const concept of model.concepts) {
		const mapping = mappings.get(String(concept.id))

		if (!mapping) continue

		for (const assertion of concept.assertions) {
			if (String(assertion.relation) !== AFFORDS_RELATION) continue

			if (String(assertion.target) !== activity) continue

			reached.push({ concept, assertion, mapping })
		}
	}

	return reached.toSorted((left, right) => compareByCodePoint(String(left.concept.id), String(right.concept.id)))
}

/**
 * Returns one message per problem found when checking a lexicon against a model.
 *
 * Each problem would make a phrase match silently and answer nothing, so construction fails on any.
 * The lexicon's own audit runs first because an injected lexicon skipped `readActivityLexicon`.
 */
function auditRoute(
	model: CompiledGeographicModel,
	lexicon: ActivityPhraseLexicon,
	resolved: ResolvedPhrase[]
): string[] {
	const problems: string[] = auditActivityLexicon(lexicon)

	if (!model.relations.some((relation) => String(relation.id) === AFFORDS_RELATION)) {
		problems.push(
			`the compiled model defines no \`${AFFORDS_RELATION}\` relation — this route reads that relation and no other`
		)
	}

	for (const { entry, normalized, reached } of resolved) {
		if (!normalized) continue

		const concept = model.concepts.find((candidate) => String(candidate.id) === entry.activity)

		if (!concept) {
			problems.push(
				`phrase ${stringifyJSON(entry.phrase)} names activity ${stringifyJSON(entry.activity)}, which the compiled model does not carry`
			)

			continue
		}

		if (concept.kind !== "activity") {
			problems.push(
				`phrase ${stringifyJSON(entry.phrase)} names ${stringifyJSON(entry.activity)}, whose concept kind is ${stringifyJSON(concept.kind)} rather than \`activity\``
			)

			continue
		}

		if (!reached.length) {
			problems.push(
				`phrase ${stringifyJSON(entry.phrase)} names activity ${stringifyJSON(entry.activity)}, which no concept both affords and maps into \`${POI_TAXONOMY_VOCABULARY}\` — the phrase would match and answer nothing`
			)
		}
	}

	return problems
}

/**
 * Returns the key that `takeObservations` deduplicates on.
 */
function observationKey(observation: SemanticObservation): string {
	return [observation.phrase, observation.matchedPhrase, observation.assertion.id, observation.categoryID].join(" ")
}

/**
 * Returns the attestation kind and reference for a declared phrase.
 *
 * A `derived-form` attestation refers to its base entry, so the reference is that base.
 */
function attestationOf(entry: ActivityPhraseEntry): { kind: string; reference: string } {
	const { attestation } = entry

	return {
		kind: attestation.kind,
		reference: attestation.kind === "derived-form" ? attestation.base : attestation.reference,
	}
}

/**
 * Builds the route from the committed model and activity lexicon, or from the injected ones.
 *
 * The function is async because the committed model reader loads through a dynamic import.
 *
 * @throws When the lexicon does not resolve against the model.
 */
export async function createSemanticObservationRoute(
	options: SemanticObservationRouteOptions = {}
): Promise<SemanticObservationRoute> {
	const model = options.model ?? (await readCommittedModel())
	const lexicon = options.lexicon ?? (await readActivityLexicon())

	const resolved: ResolvedPhrase[] = lexicon.phrases.map((entry) => ({
		entry,
		normalized: normalizeActivityPhrase(entry.phrase),
		reached: reachKinds(model, entry.activity),
	}))

	const problems = auditRoute(model, lexicon, resolved)

	if (problems.length) {
		throw new Error(
			["semantic observation route: the declared lexicon does not resolve against the compiled model:"]
				.concat(problems.map((problem) => `  - ${problem}`))
				.join("\n")
		)
	}

	// Longer phrases match first, so `pick up a prescription` wins over `prescription`.
	// Ties break on the phrase text so that lexicon order does not matter.
	const ordered = resolved.toSorted(
		(left, right) =>
			right.normalized.length - left.normalized.length || compareByCodePoint(left.normalized, right.normalized)
	)

	const recorded: SemanticObservation[] = []

	/**
	 * Records one observation per reached kind and returns the matching POI phrase matches.
	 */
	const claim = (
		declared: ResolvedPhrase,
		candidate: string,
		localeMatch: ActivityPhraseLocaleMatch,
		localeCountry: string | null,
		admitted: ReachedKind[]
	): POIPhraseMatch[] => {
		const matches: POIPhraseMatch[] = []

		for (const { concept, assertion, mapping } of admitted) {
			recorded.push({
				phrase: candidate,
				matchedPhrase: declared.entry.phrase,
				phraseLexiconID: lexicon.lexiconID,
				phraseLexiconVersion: lexicon.version,
				phraseProvenance: lexicon.provenance,
				phraseAttestation: attestationOf(declared.entry),
				localeScope: localeMatch.scope,
				declaredLocales: declared.entry.locales ? [...declared.entry.locales] : null,
				localeCountry,
				activity: declared.entry.activity,
				concept: String(concept.id),
				assertion: {
					id: String(assertion.id),
					relation: String(assertion.relation),
					modality: assertion.modality,
					countries: assertion.countries?.length ? [...assertion.countries] : null,
					provenance: assertion.provenance,
				},
				mapping: {
					id: String(mapping.id),
					vocabulary: mapping.vocabulary,
					externalID: String(mapping.externalID),
					provenance: mapping.provenance,
				},
				categoryID: String(mapping.externalID),
				mappedKindCount: admitted.length,
				modelVersion: model.modelVersion,
			})

			matches.push({
				kind: "category",
				categoryID: String(mapping.externalID),
				matchedPhrase: declared.entry.phrase,
				// The confidence is 1 for an unscoped phrase or an exact locale match,
				// and half that when only the language matches.
				// It selects a query kind and never orders candidates.
				confidence: localeMatch.confidence,
				// The POI branch searches the union of these matches.
				searchAsSet: true,
				// The intent stage applies the country scope after it parses the anchor.
				...(assertion.countries?.length
					? { countryScope: assertion.countries.map((scoped) => scoped.toUpperCase()) }
					: {}),
			})
		}

		return matches
	}

	const lookup: POIPhraseLookup = (phrase, locale) => {
		const candidate = normalizeActivityPhrase(phrase)

		if (!candidate) return []

		const country = localeToCountry(locale)

		// The locale check runs inside the loop, so a longer phrase that the locale
		// rejects cannot hide a shorter phrase that it admits.
		for (const declared of ordered) {
			if (candidate !== declared.normalized && !candidate.endsWith(` ${declared.normalized}`)) continue

			const localeMatch = resolveActivityPhraseLocale(declared.entry, locale)

			if (!localeMatch) continue

			return claim(declared, candidate, localeMatch, country ?? null, declared.reached)
		}

		return []
	}

	const reachableCategoryIDs = [
		...new Set(resolved.flatMap(({ reached }) => reached.map(({ mapping }) => String(mapping.externalID)))),
	].toSorted(compareByCodePoint)

	return {
		lookup,
		identity: {
			phraseLexiconID: lexicon.lexiconID,
			phraseLexiconVersion: lexicon.version,
			declaredPhrases: lexicon.phrases.length,
			modelVersion: model.modelVersion,
			reachableCategoryIDs,
		},
		takeObservations: () => {
			const drained: SemanticObservation[] = []
			const seen = new Set<string>()

			for (const observation of recorded) {
				const key = observationKey(observation)

				if (seen.has(key)) continue

				seen.add(key)
				drained.push(observation)
			}

			recorded.length = 0

			return drained
		},
	}
}
