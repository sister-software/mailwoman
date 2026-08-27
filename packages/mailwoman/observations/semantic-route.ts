/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The semantic route: an activity-phrased query the committed category lexicon cannot match may be
 *   answered by consulting the compiled geographic model, and the assertion that decided it travels beside
 *   the answer as an observation.
 *
 *   WHAT THE ROUTE DOES. It is a {@linkcode POIPhraseLookup} — the same injected-lexicon contract
 *   `@mailwoman/kind-classifier` already consumes — so a phrase it claims is served by the EXISTING
 *   executor exactly as if the user had typed the category. Four steps, none of which invents anything:
 *   a declared surface form names an activity concept; the compiled artifact says which entity kinds
 *   assert `affords` against that activity; a committed external mapping translates each of those
 *   concepts into a `@mailwoman/poi-taxonomy` category id; the category id goes back as positive
 *   evidence. No ordering, no weight, no boost, no penalty is authored anywhere along it — the value the
 *   match reports as its `confidence` is the one the committed exact-phrase rung reports for the same
 *   kind of hit, and it decides which query KIND is chosen rather than how any candidate is ordered.
 *
 *   WHERE THE PHRASES COME FROM, AND WHY THEY ARE NOT DATA. The compiled artifact carries concepts,
 *   relations, mappings and provenance; it carries no phrase lexicon, and minting one as though it were
 *   data is what the boundary record's section 5.5 refuses. So the surface forms are a reviewed vocabulary
 *   of their own — `@mailwoman/activity-lexicon`, where every entry names the committed record that attests
 *   it and the locales the phrasing is used in. They stay out of `@mailwoman/poi-taxonomy` because that
 *   package's phrases are venue nouns, each naming ONE category, and an activity is afforded by a SET of
 *   kinds. The lexicon declares surface forms and an activity identifier; everything a reader would call
 *   knowledge — which kinds afford the activity, under what modality, on whose authority — comes from the
 *   artifact.
 *
 *   THE PHRASE MUST END THE CANDIDATE. `matchPOISubject` probes the whole input first and then each
 *   prefix before an anchor separator, so a rung that matched an activity phrase ANYWHERE in its
 *   argument would claim the whole input — anchor included — and the executor would then have no place
 *   to search. Requiring the declared phrase to end the candidate is what keeps the anchor split intact:
 *   `where can i pick up a prescription near Denver CO` is refused whole and claimed at
 *   `where can i pick up a prescription`, leaving `Denver CO` as the anchor.
 *
 *   THE ROUTE IS NEVER ON BY DEFAULT. Nothing constructs it unless a caller asks; `createRuntimePipeline`
 *   consults it only through an optional dependency, and only after the committed category lexicon AND
 *   the POI name lookup have both returned nothing. With no route injected the pipeline is the one that
 *   shipped.
 *
 *   ONE AFFORDED KIND, OR NOTHING. An activity is afforded by a SET of entity kinds, and the query surface
 *   carries one category id: `matchPOISubject` returns `hits[0]` and `POIIntent`'s evidence names a single
 *   `categoryID`. So a set arriving here narrows to whichever concept sorts first by code point, which is
 *   an ordering nobody authored and nobody can read off the answer. Until the POI branch searches the union
 *   and lets the resolver rank it, a declared phrase whose activity reaches more than one mapped kind
 *   REFUSES AT CONSTRUCTION, naming the phrase and the kinds. The refusal is over the union rather than
 *   per-country on purpose: a route that answered where the set happens to be singular and refused
 *   elsewhere would make the collapse a property of the query, and it exists to be a finding about the
 *   lexicon and the artifact.
 *
 *   COUNTRY SCOPE IS THE ASSERTION'S, LOCALE SCOPE IS THE PHRASE'S, AND BOTH ARE READ HERE. A
 *   `RelationAssertion` may scope its claim to a country list; an assertion so scoped is admitted only when
 *   the caller's locale names a region inside it, and an unknown region admits nothing — a claim scoped to
 *   the US answering a French query would serve a category the data there cannot serve. An assertion with
 *   no country list is admitted everywhere, which is the weaker statement the schema says it is. There is
 *   deliberately no third scoping control on the pipeline option: a per-caller allow-list would be another
 *   place to look for the same answer, and would let a mis-scoped assertion pass unnoticed behind it.
 *
 *   `mailwoman` and `@mailwoman/geographic-model` must bump in ONE coordinated release. `yarn pack` freezes
 *   `workspace:*` to whatever the sibling reads at pack time, so a `mailwoman` packed ahead of the sibling's
 *   bump pins a version that will never be republished. The artifact reader stays behind a dynamic import
 *   so a caller who never builds a route never loads it.
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
import type {
	CompiledGeographicModel,
	ConceptRecord,
	ExternalMappingRecord,
	RelationAssertion,
	SourceProvenance,
} from "@mailwoman/geographic-model"
import type { POIPhraseLookup, POIPhraseMatch } from "@mailwoman/kind-classifier"

import { localeToCountry } from "../country-scope.ts"

/**
 * The relation the frozen vertical slice defines, and the only one this route reads. An assertion under any other
 * relation is not an affordance, and the route refuses an artifact that does not define this one rather than answering
 * "no kinds afford it" — an unreadable relation and an unasserted one are different findings.
 */
const AFFORDS_RELATION = "affords"

/**
 * The external vocabulary a mapping must translate into for the executor to be able to use it. A concept that affords
 * the activity but maps into no POI category cannot be searched for, which the route reports rather than hides.
 */
const POI_TAXONOMY_VOCABULARY = "poi-taxonomy"

/**
 * One firing of the route, recorded beside the answer rather than inside it.
 *
 * Everything a reader needs to say on whose authority the category was chosen is here: the declared phrase, the lexicon
 * that declared it and the record that attests the phrase itself, the activity it names, the concept whose assertion
 * carries the affordance, that assertion's own modality and provenance, and the external mapping — with its provenance
 * — that translated the concept into a POI category id.
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
	 * What attests the surface form itself — the class of record and the record. A category chosen from a phrase nobody
	 * can trace is the failure this program exists to avoid, and the assertion's provenance does not cover it: that one
	 * says why a pharmacy affords the activity, not why this string names it.
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
	 * The country the caller's locale named, or `null` when it named none. Carried on every observation because it is the
	 * value an assertion's country scope was tested against, and a receipt that shows the scope without the value it met
	 * cannot be checked.
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
	 * How many mapped entity kinds the activity reached on this firing. Always one: a phrase reaching more than one
	 * refuses at construction. Carried anyway, because a receipt showing the count was measured is what distinguishes a
	 * singular reach from a set that collapsed quietly.
	 */
	mappedKindCount: number
	modelVersion: string
}

/**
 * What the route is, stated for a receipt: which artifact and which lexicon it was built from, and what it can reach.
 *
 * A receipt that recorded only an arm LABEL would be unable to tell a run with the route from a run whose route was
 * dropped on the way in, and those produce the same numbers for opposite reasons.
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
	 * The lexicon rung. Returns `[]` for every phrase that does not end in a declared activity form the locale admits.
	 */
	lookup: POIPhraseLookup
	identity: SemanticRouteIdentity
	/**
	 * Drain the observations recorded since the last drain, deduplicated.
	 *
	 * A single query drives the rung several times — the kind scorers probe it, then the intent stage probes it again,
	 * each over the whole input and every anchor prefix — so an undeduplicated drain reports the same authority four or
	 * five times and reads as four or five decisions.
	 */
	takeObservations: () => SemanticObservation[]
}

export interface SemanticObservationRouteOptions {
	/**
	 * Override the compiled artifact — for a test that wants a synthetic model. Absent reads the committed one.
	 */
	model?: CompiledGeographicModel
	/**
	 * Override the declared lexicon. Absent reads the committed one.
	 */
	lexicon?: ActivityPhraseLexicon
}

/**
 * UTF-16 code point, ascending — the order the compiled artifact itself states.
 *
 * `String.prototype.localeCompare` is the trap this avoids: its answer depends on the machine's collation, so an order
 * built with it is reproducible only on the machine that built it. `@mailwoman/geographic-model` exports this same
 * comparator, and taking it would be a VALUE import of a package this one may only reference as a type.
 */
function byCodePoint(left: string, right: string): number {
	if (left < right) return -1

	if (left > right) return 1

	return 0
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
 * Which entity kinds assert `affords` against this activity AND map into a POI category, in concept code-point order.
 *
 * The order is a stable enumeration and not a preference, and it is never used to choose: a phrase reaching more than
 * one kind refuses at construction rather than taking the first. Deciding which of several kinds answers best would be
 * the candidate ordering this program does not author.
 *
 * Country scope is NOT applied here. The assertion's scope is met by the caller's locale, which is a per-query fact,
 * while this enumeration is what construction audits — and the audit has to see the whole set, or a phrase would refuse
 * in one country and answer in another.
 */
function reachKinds(model: CompiledGeographicModel, activity: string): ReachedKind[] {
	const mappings = new Map<string, ExternalMappingRecord>()

	for (const mapping of model.mappings) {
		if (String(mapping.vocabulary) !== POI_TAXONOMY_VOCABULARY) continue

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

	return reached.toSorted((left, right) => byCodePoint(String(left.concept.id), String(right.concept.id)))
}

/**
 * Everything wrong with a lexicon read against an artifact, one message per problem.
 *
 * Each of these is a route that would answer NOTHING while looking like a route that found nothing, which is the shape
 * of failure a probe cannot distinguish from a real absence. So they refuse at construction rather than at query time.
 *
 * The vocabulary's own audit runs first and is not restated here: an injected lexicon never passed through
 * `readActivityLexicon`, so a route built from one would otherwise accept a duplicate, an empty list or a phrase that
 * normalizes away.
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
				`phrase ${JSON.stringify(entry.phrase)} names activity ${JSON.stringify(entry.activity)}, which the compiled model does not carry`
			)

			continue
		}

		if (String(concept.kind) !== "activity") {
			problems.push(
				`phrase ${JSON.stringify(entry.phrase)} names ${JSON.stringify(entry.activity)}, whose concept kind is ${JSON.stringify(String(concept.kind))} rather than \`activity\``
			)

			continue
		}

		if (!reached.length) {
			problems.push(
				`phrase ${JSON.stringify(entry.phrase)} names activity ${JSON.stringify(entry.activity)}, which no concept both affords and maps into \`${POI_TAXONOMY_VOCABULARY}\` — the phrase would match and answer nothing`
			)

			continue
		}

		if (reached.length > 1) {
			const kinds = reached
				.map(({ concept: reachedConcept, mapping }) => `${String(reachedConcept.id)} → ${String(mapping.externalID)}`)
				.join(", ")

			problems.push(
				`phrase ${JSON.stringify(entry.phrase)} names activity ${JSON.stringify(entry.activity)}, which reaches ${reached.length} mapped kinds (${kinds}) — the query surface carries one category id, so the set would narrow to whichever concept sorts first by code point`
			)
		}
	}

	return problems
}

/**
 * Whether an assertion's country scope admits the country the caller's locale named.
 *
 * An assertion with no country list is admitted everywhere. A scoped one needs the country, and an unknown country
 * admits nothing: a claim the curator scoped to a place cannot be reached without knowing the place, or the record
 * means something different from what it says. Same containment the locale scope applies to a regional phrasing.
 */
function admitsCountry(assertion: RelationAssertion, country: string | undefined): boolean {
	if (!assertion.countries?.length) return true

	if (!country) return false

	return assertion.countries.some((scoped) => scoped.toUpperCase() === country)
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
 * `derived-form` points at another entry rather than at an outside record, so its reference is that base — which is
 * what a reader following the chain needs next.
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
 * Asynchronous because the artifact reader is reached by dynamic import, which keeps it off the load path of a caller
 * who never builds a route.
 */
export async function createSemanticObservationRoute(
	options: SemanticObservationRouteOptions = {}
): Promise<SemanticObservationRoute> {
	const model = options.model ?? (await readCommittedModel())
	const lexicon = options.lexicon ?? readActivityLexicon()

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

	// Longest declared phrase first, so `pick up a prescription` beats the bare `prescription` it ends with. Ties break on
	// the phrase itself, so the winner is a property of the lexicon rather than of the order it was written in.
	const ordered = resolved.toSorted(
		(left, right) => right.normalized.length - left.normalized.length || byCodePoint(left.normalized, right.normalized)
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
					modality: String(assertion.modality),
					countries: assertion.countries?.length ? [...assertion.countries] : null,
					provenance: assertion.provenance,
				},
				mapping: {
					id: String(mapping.id),
					vocabulary: String(mapping.vocabulary),
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
				// The confidence the committed exact-phrase rung reports for the same kind of hit: `1` for a phrase used
				// everywhere or one the locale names outright, and the halved value `@mailwoman/variant-aliases` reports when
				// only the language agrees. It selects a query KIND; it orders no candidate, and no number here was chosen to
				// make one win.
				confidence: localeMatch.confidence,
			})
		}

		return matches
	}

	const lookup: POIPhraseLookup = (phrase, locale) => {
		const candidate = normalizeActivityPhrase(phrase)

		if (!candidate) return []

		const country = localeToCountry(locale)

		// Both scopes are read INSIDE the search rather than after it: a longer phrase one of them refuses must not stand in
		// front of a shorter one both admit, or a scope would silence a phrase it does not cover.
		for (const declared of ordered) {
			if (candidate !== declared.normalized && !candidate.endsWith(` ${declared.normalized}`)) continue

			const localeMatch = resolveActivityPhraseLocale(declared.entry, locale)

			if (!localeMatch) continue

			const admitted = declared.reached.filter(({ assertion }) => admitsCountry(assertion, country))

			if (!admitted.length) continue

			return claim(declared, candidate, localeMatch, country ?? null, admitted)
		}

		return []
	}

	const reachableCategoryIDs = [
		...new Set(resolved.flatMap(({ reached }) => reached.map(({ mapping }) => String(mapping.externalID)))),
	].toSorted(byCodePoint)

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

/**
 * The committed compiled artifact, read through the package that owns it. Never the authoring records: the runtime side
 * of this program consumes an artifact, and traversing authoring JSON is what the boundary record excludes.
 */
async function readCommittedModel(): Promise<CompiledGeographicModel> {
	const { readCompiledGeographicModel } = await import("@mailwoman/geographic-model/scripts/build-artifact")

	return readCompiledGeographicModel()
}
