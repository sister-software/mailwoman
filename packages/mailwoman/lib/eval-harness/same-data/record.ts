/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture recorder for the same-data benchmark (#2261). It drives the real backend once per arm
 *   configuration and freezes every answer, so no arm touches a gazetteer afterwards.
 *
 *   The recording runs once per registered option set and unions the keys, because each arm asks different
 *   questions: `parentFallback: false` drops a retry nothing else asks for, and `adminCoherence: false`
 *   changes which nodes are probed. A fixture recorded from one arm makes the others miss, which
 *   `replayBackend` raises on.
 *
 *   Withheld verdict fields are stripped here, the only place that sees the backend's full answer, so no
 *   fixture ever exists that could hand an arm a partly solved row.
 *
 *   The withheld-gold stratum is filtered during recording rather than subtracted from a finished one.
 *   Without the gold the walk picks a different candidate, resolves a different parent, and asks questions
 *   the recording would not hold. Every member of the gold identity set is filtered: leaving one member of a
 *   place the gazetteer carries twice leaves it answerable.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { parseJSONStrict } from "@mailwoman/core/json"
import type { ResolvedPlace, ResolveOpts, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"

import {
	candidatePool,
	canonicalQueryKey,
	SAME_DATA_SCHEMA_VERSION,
	type SameDataCandidate,
	type SameDataFixtureRow,
	type SameDataLookup,
	type SameDataPanelRow,
	type SameDataQuery,
} from "#eval-harness/same-data/fixture"

/**
 * Drop the query-verdict fields a fixture may never carry.
 *
 * Destructured rather than filtered by key, so the compiler checks the result: the return type is derived from
 * `WITHHELD_CANDIDATE_FIELDS`, so a field added to that tuple and not named here is a type error rather than a verdict
 * that quietly reaches the fixture.
 */
function stripWithheld(place: ResolvedPlace): SameDataCandidate {
	const { containedByQualifier, mismatch, regionScopeMiss, resolutionQuality, variantAliasExempted, ...candidate } =
		place

	return candidate
}

/**
 * A backend that answers from the real one and records every question and answer.
 *
 * The recorded answer is the STRIPPED form, so what the fixture holds is what the arms will later read — recording the
 * full answer and stripping at write time would leave the recording and the replay disagreeing about what the walk
 * saw.
 */
function recordingBackend(
	backend: ResolverBackend,
	into: Map<string, SameDataLookup>,
	withheld: ((place: ResolvedPlace) => boolean) | null,
	onWithhold: (count: number) => void
): ResolverBackend {
	return {
		...backend,
		async findPlace(query: SameDataQuery) {
			const raw = await backend.findPlace(query)
			const answer = withheld ? raw.filter((place) => !withheld(place)) : raw

			if (withheld) {
				onWithhold(raw.length - answer.length)
			}

			const key = canonicalQueryKey(query)

			if (!into.has(key)) {
				// The stored query is parsed BACK from the key rather than kept by reference. The walk reuses and MUTATES
				// its query object after the call returns — it adds `parentID` once a parent resolves — so a stored
				// reference ends up describing a question that was never asked, and the fixture's key and query disagree.
				// Round-tripping through the key also makes the two agree by construction.
				into.set(key, {
					key,
					// A throw is the contract: the key is this process's own canonical JSON, so a parse failure means the
					// encoder is broken and every recorded row after it would be wrong.
					query: parseJSONStrict<SameDataQuery>(key),
					candidates: answer.map((place) => stripWithheld(place)),
				})
			}

			return answer
		},
	}
}

/**
 * What one row's recording cost and produced — reported beside the fixture, never folded into it.
 */
export interface RecordCensus {
	rowID: string
	lookups: number
	candidates: number
	/**
	 * Candidate answers the gold filter withheld during recording, counted across every question asked. Zero everywhere
	 * except the withheld-gold stratum; a non-zero value on a `goldPresent` row would be a defect.
	 */
	removedGold: number
	/**
	 * Set when an arm's walk raised while recording. The row is still written — a walk that failed under one option set
	 * may have recorded useful keys under another — and the run receipt carries the count.
	 */
	error?: string
}

export interface RecordInputs {
	panel: readonly SameDataPanelRow[]
	backend: ResolverBackend
	/**
	 * Turn one raw query into the frozen parse. Injected so the recorder does not decide which model runs.
	 */
	parse: (query: string) => Promise<AddressTree>
	/**
	 * Every arm's `ResolveOpts`, so the recording covers each arm's questions. The production arm's empty option bag must
	 * be included explicitly — an omitted default is a missing key at replay.
	 */
	armOptions: ReadonlyArray<ResolveOpts>
	/**
	 * Withhold every row DENOTING the gold place, not only the ids the concordance linked. Off by default, and the
	 * default is what keeps `same-data-resolver-v1` and `prominence-floor-v1` byte-stable on a re-record.
	 *
	 * Why it exists: the gold identity set is built from the `gn:id` concordance, and the gazetteer carries **285,478 of
	 * its 2,689,326 populated localities twice** — 10.6% share a folded name with a `localadmin` within 5 km, and 264,523
	 * of those name that twin as their depth-1 ancestor. Removing the concorded id leaves the twin answerable, so an arm
	 * returning it is graded as selecting where no correct candidate exists. It named the right place. Measured on
	 * `same-data-resolver-v1`: 10 of 100 withheld-gold rows, and three of the five rows published as exemplars of
	 * confident failure — `Langfang` 2.8 km, `Matsusaka` 1.3 km, `Troyes` 0.6 km.
	 *
	 * Turning it on changes what the stratum means, so it belongs to a successor definition rather than a version bump of
	 * a benchmark whose arms have run. `benchmark-freeze.json` states the reason: a rule editable after a result is
	 * visible asserts nothing.
	 */
	withholdEveryDenotingRow?: boolean
}

export interface RecordResult {
	fixture: SameDataFixtureRow[]
	census: RecordCensus[]
}

/**
 * How far apart two rows bearing the same folded name may sit and still denote one settlement. 5 km is the radius the
 * `same-data-resolver-v1` correction re-graded at, where it credited 10 of 100 withheld-gold rows; at 25 km it credits
 * 15, so the figure moves with the radius and the radius is stated wherever the figure is.
 */
const SAME_SETTLEMENT_KM = 5

/**
 * The diacritic-folded comparison surface. Deliberately not the resolver's `foldName`: that one empties a non-Latin
 * name, so `東京` and `Москва` would fold equal to each other and to every other non-Latin row.
 */
function settlementKey(name: string): string {
	return name
		.normalize("NFD")
		.replaceAll(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, "")
}

/**
 * What the recorder withholds for one row, or null when the row carries its gold.
 *
 * The default is id equality — the rule `same-data-resolver-v1` was frozen under. Under
 * {@link RecordInputs.withholdEveryDenotingRow} it also withholds a row whose folded name equals the gold's within
 * {@link SAME_SETTLEMENT_KM}, which is the settlement-identity rule: the gazetteer carries one place at two admin tiers
 * and the concordance links only one of them.
 */
function withholdPredicate(
	row: SameDataPanelRow,
	everyDenotingRow: boolean
): ((place: ResolvedPlace) => boolean) | null {
	if (row.goldPresent) return null

	const ids = new Set(row.gold.placeIDs.map((placeID) => String(placeID)))

	if (!everyDenotingRow) return (place) => ids.has(String(place.id))

	const goldKey = settlementKey(row.gold.name)

	return (place) => {
		if (ids.has(String(place.id))) return true

		if (!place.name || settlementKey(place.name) !== goldKey) return false

		// Both halves are required. `Batāla` (IN) and `Batala` (IN) fold equal and sit 1,421 km apart — a real namesake,
		// and withholding it would remove a candidate the stratum is entitled to offer.
		return haversineKm(place.lat, place.lon, row.gold.lat, row.gold.lon) <= SAME_SETTLEMENT_KM
	}
}

/**
 * Record the frozen evidence for every panel row.
 */
export async function recordFixture(inputs: RecordInputs): Promise<RecordResult> {
	const { panel, backend, parse, armOptions } = inputs
	const fixture: SameDataFixtureRow[] = []
	const census: RecordCensus[] = []

	for (const row of panel) {
		const tree = await parse(row.query)
		const lookups = new Map<string, SameDataLookup>()
		// Not `error`: the catch binding below takes that name, and a same-named outer variable is shadowed — the
		// assignment would write to the parameter and the receipt would report a clean run over a failed one.
		let recordingError: string | undefined

		let removedGold = 0
		const withheld = withholdPredicate(row, inputs.withholdEveryDenotingRow === true)

		// One recording backend for the row, shared across the arm option sets: the lookup map and the withheld count are
		// per ROW, and building the closure inside the loop would capture the counter afresh each pass.
		const recorder = createWOFResolver(
			recordingBackend(backend, lookups, withheld, (count) => {
				removedGold += count
			})
		)

		for (const options of armOptions) {
			try {
				await recorder.resolveTree(tree, options)
			} catch (error) {
				recordingError = error instanceof Error ? error.message : String(error)
			}
		}

		const recorded = [...lookups.values()]

		fixture.push({
			id: row.id,
			schemaVersion: SAME_DATA_SCHEMA_VERSION,
			tree,
			lookups: recorded,
			pool: candidatePool(recorded),
		})

		census.push({
			rowID: row.id,
			lookups: recorded.length,
			candidates: recorded.reduce((total, lookup) => total + lookup.candidates.length, 0),
			removedGold,
			...(recordingError ? { error: recordingError } : {}),
		})
	}

	return { fixture, census }
}
