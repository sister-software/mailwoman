/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture recorder for the same-data benchmark: it drives the real backend once per arm
 *   configuration and freezes every answer, so no arm touches a gazetteer afterwards.
 *
 *   The recording runs once per registered option set and unions the keys, because each arm asks
 *   different questions and a fixture recorded from one arm makes the others miss.
 *
 *   Withheld verdict fields are stripped here, the only place that sees the backend's full answer.
 *
 *   The withheld-gold stratum is filtered during recording rather than subtracted from a finished one,
 *   because without the gold the walk picks a different candidate and asks questions the recording
 *   would not hold.
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
 * Destructured rather than filtered by key so the compiler checks the return
 * type against `WITHHELD_CANDIDATE_FIELDS`.
 */
function stripWithheld(place: ResolvedPlace): SameDataCandidate {
	const { containedByQualifier, mismatch, regionScopeMiss, resolutionQuality, variantAliasExempted, ...candidate } =
		place

	return candidate
}

/**
 * A backend that answers from the real one and records every question and answer in
 * stripped form, so the recording and the replay agree about what the walk saw.
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
				// The stored query is parsed back from the key instead of kept by reference.
				// The walk mutates its query object after the call returns, so retaining it
				// would leave the fixture key and query in disagreement.
				into.set(key, {
					key,
					// A throw is the interface: the key is this process's own canonical JSON,
					// so a parse failure means the encoder is broken.
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
	 * Candidate answers the gold filter withheld during recording, zero everywhere
	 * except the withheld-gold stratum.
	 */
	removedGold: number
	/**
	 * Set when an arm's walk raised while recording.
	 *
	 * The recorder writes the row.
	 * The run receipt carries the count.
	 */
	error?: string
}

export interface RecordInputs {
	panel: readonly SameDataPanelRow[]
	backend: ResolverBackend
	/**
	 * Turn one raw query into the frozen parse, injected so the recorder does not decide which model runs.
	 */
	parse: (query: string) => Promise<AddressTree>
	/**
	 * Every arm's `ResolveOpts`, so the recording covers each arm's questions.
	 *
	 * The production arm's empty option bag must be included explicitly,
	 * because an omitted default is a missing key at replay.
	 */
	armOptions: ReadonlyArray<ResolveOpts>
	/**
	 * Withhold every row that denotes the gold place, including rows whose ids the concordance did not link.
	 *
	 * The option defaults to `false`, keeping frozen definitions byte-stable on a re-record.
	 * It exists because the gold identity set comes from the `gn:id` concordance
	 * while the gazetteer carries 285,478 of 2,689,326 populated localities twice,
	 * so removing the concorded id leaves the twin answerable and an arm returning it
	 * is graded as selecting where no correct candidate exists.
	 *
	 * Turning it on changes what the stratum means, so it belongs to a successor definition
	 * rather than a version bump of a benchmark whose arms have run.
	 */
	withholdEveryDenotingRow?: boolean
}

export interface RecordResult {
	fixture: SameDataFixtureRow[]
	census: RecordCensus[]
}

/**
 * Maximum distance for treating two rows with the same folded name as one settlement.
 *
 * The 5 km value defines this matcher's scope.
 * Reports include the radius because changing it changes the result.
 */
const SAME_SETTLEMENT_KM = 5

/**
 * The diacritic-folded comparison surface, deliberately not the resolver's `foldName`,
 * which empties a non-Latin name so `東京` and `Москва` would fold equal.
 */
function settlementKey(name: string): string {
	return name
		.normalize("NFD")
		.replaceAll(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, "")
}

/**
 * Returns the recorder's withholding decision for one row.
 *
 * It returns `null` when the row carries its gold.
 * The default compares ids. {@link RecordInputs.withholdEveryDenotingRow} also includes
 * rows whose folded name matches the gold within {@link SAME_SETTLEMENT_KM}.
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

		// Both halves are required: `Batāla` (IN) and `Batala` (IN) fold equal and sit 1,421 km apart.
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
		// Not `error`: the catch binding below takes that name, so an outer variable with the
		// same name would be shadowed and the receipt would report a clean run over a failed one.
		let recordingError: string | undefined

		let removedGold = 0
		const withheld = withholdPredicate(row, inputs.withholdEveryDenotingRow === true)

		// One recording backend per row, shared across the arm option sets,
		// so the lookup map and the withheld count stay per row.
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
