/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ONE semantic route the utility probe injects (#1929), and nothing else: an activity-phrased query
 *   the committed category lexicon cannot match may be answered by consulting the compiled geographic
 *   model, and the assertion that decided it travels beside the answer as an observation.
 *
 *   WHAT THE ROUTE DOES. It is a {@linkcode POIPhraseLookup} — the same injected-lexicon contract
 *   `@mailwoman/kind-classifier` already consumes — so a phrase it claims is served by the EXISTING
 *   executor exactly as if the user had typed the category. Four steps, none of which invents anything:
 *   a declared surface form names an activity concept; the compiled artifact says which entity kinds
 *   assert `affords` against that activity; a committed external mapping translates each of those
 *   concepts into a `@mailwoman/poi-taxonomy` category id; the category id goes back as positive
 *   evidence. No ordering, no weight, no boost, no penalty is authored anywhere along it — the value the
 *   match reports as its `confidence` is the `1` the committed exact-phrase rung reports for an exact
 *   hit, because the recognition IS an exact match against a declared phrase, and it decides which query
 *   KIND is chosen rather than how any candidate is ordered.
 *
 *   WHERE THE PHRASES COME FROM, AND WHY THEY ARE NOT DATA. The compiled artifact carries concepts,
 *   relations, mappings and provenance; it carries no phrase lexicon, and minting one as though it were
 *   data is what the boundary record's section 5.5 refuses. So the surface forms are authored, in
 *   `activity-phrases.json`, and that file's provenance says in the first sentence that it was authored
 *   for one experiment. They stay out of `@mailwoman/poi-taxonomy` because that package's phrases are
 *   venue nouns, each naming ONE category, and an activity is afforded by a SET of kinds. The table
 *   declares surface forms and an activity identifier; everything a reader would call knowledge —
 *   which kinds afford the activity, under what modality, on whose authority — comes from the artifact.
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
 *   `mailwoman` must not carry a RUNTIME dependency on `@mailwoman/geographic-model`: that workspace is
 *   outside the release list, so a published `mailwoman` naming it would name a version no registry
 *   carries. It is a devDependency here, and the artifact reader is reached by dynamic import so nothing
 *   loads it unless a caller builds a route.
 */

import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { parseJSONStrict } from "@mailwoman/core/objects"
import type {
	CompiledGeographicModel,
	ConceptRecord,
	ExternalMappingRecord,
	RelationAssertion,
	SourceProvenance,
} from "@mailwoman/geographic-model"
import type { POIPhraseLookup, POIPhraseMatch } from "@mailwoman/kind-classifier"

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
 * One declared surface form: the text a person types, and the activity concept it names.
 */
export interface ActivityPhraseEntry {
	phrase: string
	/**
	 * A concept identifier the compiled artifact carries, of kind `activity`. The route refuses an entry naming anything
	 * else.
	 */
	activity: string
	note: string
}

/**
 * The declared table, with the provenance that marks it authored rather than measured.
 */
export interface ActivityPhraseTable {
	tableID: string
	version: string
	provenance: SourceProvenance
	phrases: ActivityPhraseEntry[]
}

/**
 * One firing of the route, recorded beside the answer rather than inside it.
 *
 * Everything a reader needs to say on whose authority the category was chosen is here: the declared phrase and the
 * table that declared it, the activity it names, the concept whose assertion carries the affordance, that assertion's
 * own modality and provenance, and the external mapping — with its provenance — that translated the concept into a POI
 * category id.
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
	phraseTableID: string
	phraseTableVersion: string
	phraseProvenance: SourceProvenance
	activity: string
	concept: string
	assertion: {
		id: string
		relation: string
		modality: string
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
	 * How many mapped entity kinds the activity reached on this firing. One today. A number above one is a finding for
	 * the decision record, not something this route resolves: choosing among them would be the ordering it must not
	 * author.
	 */
	mappedKindCount: number
	modelVersion: string
}

/**
 * What the route is, stated for a receipt: which artifact and which table it was built from, and what it can reach.
 *
 * A receipt that recorded only an arm LABEL would be unable to tell a run with the route from a run whose route was
 * dropped on the way in, and those produce the same numbers for opposite reasons.
 */
export interface SemanticRouteIdentity {
	phraseTableID: string
	phraseTableVersion: string
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
	 * The lexicon rung. Returns `[]` for every phrase that does not end in a declared activity form.
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
	 * Override the declared phrase table. Absent reads the committed one.
	 */
	phraseTable?: ActivityPhraseTable
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

function sourceRelative(name: string): string {
	// `tsc` emits no `.json` into `out/`, so a compiled caller reads the source-tree copy — the same bridge
	// `probe.ts` uses for the pre-registration.
	const sibling = fileURLToPath(new URL(name, import.meta.url))

	if (existsSync(sibling)) return sibling

	return fileURLToPath(new URL(`../../../eval-harness/semantic-utility/${name}`, import.meta.url))
}

/**
 * The committed declared phrase table.
 */
export const ACTIVITY_PHRASE_TABLE_PATH = sourceRelative("activity-phrases.json")

/**
 * Read the committed declared phrase table.
 */
export function readActivityPhraseTable(path: string = ACTIVITY_PHRASE_TABLE_PATH): ActivityPhraseTable {
	return parseJSONStrict<ActivityPhraseTable>(readFileSync(path, "utf8"))
}

/**
 * Normalize a phrase for comparison: NFKC, trimmed, whitespace collapsed, lowercased.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`, deliberately: the locale-sensitive form folds a dotted capital `I` to
 * `i̇` under a Turkish host locale, which would make the route answer differently on two machines running the same
 * query.
 */
function normalizePhrase(phrase: string): string {
	return phrase.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase()
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
 * The order is a stable enumeration and not a preference. Nothing here decides which of several kinds answers best;
 * that decision would be the candidate ordering this program does not author.
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
 * Everything wrong with a table read against an artifact, one message per problem.
 *
 * Each of these is a route that would answer NOTHING while looking like a route that found nothing, which is the shape
 * of failure a probe cannot distinguish from a real absence. So they refuse at construction rather than at query time.
 */
function auditRoute(model: CompiledGeographicModel, table: ActivityPhraseTable, resolved: ResolvedPhrase[]): string[] {
	const problems: string[] = []

	if (!model.relations.some((relation) => String(relation.id) === AFFORDS_RELATION)) {
		problems.push(
			`the compiled model defines no \`${AFFORDS_RELATION}\` relation — this route reads that relation and no other`
		)
	}

	if (!table.phrases.length) {
		problems.push("the declared phrase table is empty — a route with no surface form can never fire")
	}

	const seen = new Set<string>()

	for (const { entry, normalized, reached } of resolved) {
		if (seen.has(normalized)) {
			problems.push(`phrase ${JSON.stringify(entry.phrase)} is declared twice`)
		}

		seen.add(normalized)

		if (!normalized) {
			problems.push(`phrase ${JSON.stringify(entry.phrase)} normalizes to nothing`)

			continue
		}

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
		}
	}

	return problems
}

/**
 * The observation key a drain deduplicates on: one authority reached from one candidate phrase.
 */
function observationKey(observation: SemanticObservation): string {
	return [observation.phrase, observation.matchedPhrase, observation.assertion.id, observation.categoryID].join(" ")
}

/**
 * Build the route from the committed artifact and the committed declared phrase table.
 *
 * Asynchronous because the artifact reader is reached by dynamic import — see the module header for why this package
 * holds no runtime dependency on `@mailwoman/geographic-model`.
 */
export async function createSemanticObservationRoute(
	options: SemanticObservationRouteOptions = {}
): Promise<SemanticObservationRoute> {
	const model = options.model ?? (await readCommittedModel())
	const table = options.phraseTable ?? readActivityPhraseTable()

	const resolved: ResolvedPhrase[] = table.phrases.map((entry) => ({
		entry,
		normalized: normalizePhrase(entry.phrase),
		reached: reachKinds(model, entry.activity),
	}))

	const problems = auditRoute(model, table, resolved)

	if (problems.length) {
		throw new Error(
			["semantic observation route: the declared table does not resolve against the compiled model:"]
				.concat(problems.map((problem) => `  - ${problem}`))
				.join("\n")
		)
	}

	// Longest declared phrase first, so `pick up a prescription` beats the bare `prescription` it ends with. Ties break on
	// the phrase itself, so the winner is a property of the table rather than of the order it was written in.
	const ordered = resolved.toSorted(
		(left, right) => right.normalized.length - left.normalized.length || byCodePoint(left.normalized, right.normalized)
	)

	const recorded: SemanticObservation[] = []

	const lookup: POIPhraseLookup = (phrase) => {
		const candidate = normalizePhrase(phrase)

		if (!candidate) return []

		const hit = ordered.find(
			(declared) => candidate === declared.normalized || candidate.endsWith(` ${declared.normalized}`)
		)

		if (!hit) return []

		const matches: POIPhraseMatch[] = []

		for (const { concept, assertion, mapping } of hit.reached) {
			recorded.push({
				phrase: candidate,
				matchedPhrase: hit.entry.phrase,
				phraseTableID: table.tableID,
				phraseTableVersion: table.version,
				phraseProvenance: table.provenance,
				activity: hit.entry.activity,
				concept: String(concept.id),
				assertion: {
					id: String(assertion.id),
					relation: String(assertion.relation),
					modality: String(assertion.modality),
					provenance: assertion.provenance,
				},
				mapping: {
					id: String(mapping.id),
					vocabulary: String(mapping.vocabulary),
					externalID: String(mapping.externalID),
					provenance: mapping.provenance,
				},
				categoryID: String(mapping.externalID),
				mappedKindCount: hit.reached.length,
				modelVersion: model.modelVersion,
			})

			matches.push({
				kind: "category",
				categoryID: String(mapping.externalID),
				matchedPhrase: hit.entry.phrase,
				// The confidence the committed exact-phrase rung reports for an exact hit. It selects a query KIND; it
				// orders no candidate, and no number here was chosen to make one win.
				confidence: 1,
			})
		}

		return matches
	}

	const reachableCategoryIDs = [
		...new Set(resolved.flatMap(({ reached }) => reached.map(({ mapping }) => String(mapping.externalID)))),
	].toSorted(byCodePoint)

	return {
		lookup,
		identity: {
			phraseTableID: table.tableID,
			phraseTableVersion: table.version,
			declaredPhrases: table.phrases.length,
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
