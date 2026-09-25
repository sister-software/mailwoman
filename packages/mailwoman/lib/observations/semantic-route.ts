/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolve activity phrases through the compiled geographic model when ordinary POI lookup misses.
 *   The artifact supplies affordance assertions and category mappings; the activity lexicon supplies
 *   attested phrases. The route is opt-in, preserves anchor splitting, and records its evidence.
 *   It returns all mapped kinds without ranking them; the resolver selects among results.
 *   Phrase locale scope applies to the caller, while assertion country scope applies to the resolved anchor.
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
 * The relation the frozen vertical defines, and the only one this route reads.
 *
 * An assertion under any other relation is not an affordance, and the route refuses an
 * artifact that does not define this one rather than answering "no kinds afford it".
 * An unreadable relation and an unasserted one are different findings.
 */
const AFFORDS_RELATION = "affords"

/**
 * The external vocabulary a mapping must translate into for the executor to be able to use it.
 *
 * A concept that affords the activity but maps into no POI category cannot be searched for,
 * which the route reports rather than hides.
 */
const POI_TAXONOMY_VOCABULARY = "poi-taxonomy"

/**
 * One firing of the route, recorded beside the answer rather than inside it.
 *
 * Everything a reader needs to say on whose authority the category was chosen is here:
 * the declared phrase, the lexicon that declared it and the record that attests the phrase
 * itself, the activity it names, the concept whose assertion carries the affordance,
 * that assertion's own modality and provenance, and the external mapping —
 * with its provenance — that translated the concept into a POI category id.
 */
export interface SemanticObservation {
	/**
	 * The candidate subject phrase the rung was asked about, as `matchPOISubject` handed it over.
	 */
	phrase: string
	/**
	 * The declared surface form that matched it.
	 */
	matchedPhrase: string
	phraseLexiconID: string
	phraseLexiconVersion: string
	phraseProvenance: SourceProvenance
	/**
	 * What attests the surface form itself — the class of record and the record.
	 *
	 * A category chosen from a phrase nobody can trace is the failure this program exists
	 * to avoid, and the assertion's provenance does not cover it: that one says why a
	 * pharmacy affords the activity rather than why this string names it.
	 */
	phraseAttestation: {
		kind: string
		reference: string
	}
	/**
	 * How the entry's locale scope met the locale the query was read under.
	 */
	localeScope: ActivityPhraseLocaleScope
	/**
	 * The tags the entry declares, or `null` when it is unscoped.
	 */
	declaredLocales: string[] | null
	/**
	 * The country the caller's locale named, or `null` when it named none.
	 * The lens the phrase was read through.
	 *
	 * It is not what the assertion's country scope was tested against: that is the resolved
	 * anchor's country, which the POI intent stage binds after this observation is recorded
	 * and reports on the intent's `countryBinding`.
	 */
	localeCountry: string | null
	activity: string
	concept: string
	assertion: {
		id: string
		relation: string
		modality: string
		/**
		 * The countries the assertion scopes its claim to, or `null` when it scopes it to none in particular.
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
	 * The POI category id handed back to the pipeline — the mapping's `externalID`.
	 */
	categoryID: string
	/**
	 * How many mapped entity kinds the activity reached on this firing.
	 *
	 * The set handed to the POI branch before the anchor's country was bound.
	 *
	 * One observation is recorded per member, each naming its own assertion and mapping,
	 * and every one of them carries this same count.
	 * A receipt showing it is what distinguishes a genuinely singular reach from a set that collapsed quietly.
	 */
	mappedKindCount: number
	modelVersion: string
}

/**
 * What the route is, stated for a receipt: which artifact and which lexicon it
 * was built from, and what it can reach.
 *
 * A receipt that recorded only an arm label would be unable to tell a run with the route from a
 * run whose route was dropped on the way in, and those produce the same numbers for opposite reasons.
 */
export interface SemanticRouteIdentity {
	phraseLexiconID: string
	phraseLexiconVersion: string
	declaredPhrases: number
	modelVersion: string
	/**
	 * Every POI category id the declared activities can reach through the artifact, in code-point order.
	 */
	reachableCategoryIDs: string[]
}

/**
 * The injectable route.
 */
export interface SemanticObservationRoute {
	/**
	 * The lexicon rung.
	 *
	 * @returns `[]` for every phrase that does not end in a declared activity form the locale admits.
	 */
	lookup: POIPhraseLookup
	identity: SemanticRouteIdentity
	/**
	 * Drain the observations recorded since the last drain, deduplicated.
	 *
	 * A single query drives the rung several times — the kind scorers probe it, then the intent stage
	 * probes it again, each over the whole input and every anchor prefix — so an undeduplicated
	 * drain reports the same authority four or five times and reads as four or five decisions.
	 */
	takeObservations: () => SemanticObservation[]
}

export interface SemanticObservationRouteOptions {
	/**
	 * Override the compiled artifact, for a test that wants a synthetic model.
	 *
	 * Absent reads the committed one.
	 */
	model?: CompiledGeographicModel
	/**
	 * Override the declared lexicon.
	 *
	 * Absent reads the committed one.
	 */
	lexicon?: ActivityPhraseLexicon
}

/**
 * One declared phrase, resolved all the way to the categories it can reach.
 */
interface ResolvedPhrase {
	entry: ActivityPhraseEntry
	normalized: string
	reached: ReachedKind[]
}

/**
 * One entity kind that affords a declared activity, and the mapping that makes it searchable.
 */
interface ReachedKind {
	concept: ConceptRecord
	assertion: RelationAssertion
	mapping: ExternalMappingRecord
}

/**
 * Which entity kinds assert `affords` against this activity and map into a POI
 * category, in concept code-point order.
 *
 * The order is a stable enumeration and not a preference, and it is never used to choose:
 * every member is returned and the POI branch searches their union.
 * Deciding which of several kinds answers best would be the candidate ordering this program does not author.
 *
 * Country scope is not applied here, or anywhere in this route: the assertion's scope is met by
 * the country of the resolved anchor, which exists only after the intent stage has parsed the anchor.
 * This enumeration is what construction audits, and the audit has to see the whole set,
 * or a phrase would be audited against one country's reach and used in another's.
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
 * Everything wrong with a lexicon read against an artifact, one message per problem.
 *
 * Each of these is a route that would answer nothing while looking like a route that found
 * nothing, which is the shape of failure a probe cannot distinguish from a real absence.
 * So they refuse at construction rather than at query time.
 *
 * The vocabulary's own audit runs first and is not restated here: an injected lexicon
 * never passed through `readActivityLexicon`, so a route built from one would otherwise
 * accept a duplicate, an empty list or a phrase that normalizes away.
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
 * The observation key a drain deduplicates on: one authority reached from one candidate phrase.
 */
function observationKey(observation: SemanticObservation): string {
	return [observation.phrase, observation.matchedPhrase, observation.assertion.id, observation.categoryID].join(" ")
}

/**
 * The record that attests one declared phrase, flattened to the two fields a receipt reads.
 *
 * `derived-form` points at another entry rather than at an outside record, so its
 * reference is that base, which is what a reader following the chain needs next.
 */
function attestationOf(entry: ActivityPhraseEntry): { kind: string; reference: string } {
	const { attestation } = entry

	return {
		kind: attestation.kind,
		reference: attestation.kind === "derived-form" ? attestation.base : attestation.reference,
	}
}

/**
 * Build the route from the committed artifact and the committed activity lexicon.
 *
 * Asynchronous because the artifact reader is reached by dynamic import,
 * which keeps it off the load path of a caller who never builds a route.
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

	// Longest declared phrase first, so `pick up a prescription` beats the bare `prescription` it ends with.
	// Ties break on the phrase itself, so the winner is a property of the lexicon
	// rather than of the order it was written in.
	const ordered = resolved.toSorted(
		(left, right) =>
			right.normalized.length - left.normalized.length || compareByCodePoint(left.normalized, right.normalized)
	)

	const recorded: SemanticObservation[] = []

	/**
	 * Record one firing and hand back what the pipeline is told about it.
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
				// The confidence the committed exact-phrase rung reports for the same kind of hit:
				// `1` for a phrase used everywhere or one the locale names outright, and the halved
				// value `@mailwoman/variant-aliases` reports when only the language agrees.
				// It selects a query kind.
				// It orders no candidate, and no number here was chosen to make one win.
				// Every member of a set carries the same value, so the set cannot be ranked by it either.
				confidence: localeMatch.confidence,
				// These matches are one afforded set rather than a preference list: the POI branch searches their union.
				searchAsSet: true,
				// The assertion's claim rides with the match for the intent stage to
				// bind against the anchor's country.
				// It is not applied here: the anchor has not been parsed yet when this runs.
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

		// The locale scope is read inside the search rather than after it:
		// a longer phrase it refuses must not stand in front of a shorter one it admits,
		// or the scope would silence a phrase it does not cover.
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
