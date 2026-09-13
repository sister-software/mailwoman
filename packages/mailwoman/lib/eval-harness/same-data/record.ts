/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture recorder for the same-data benchmark (#2261): it drives the REAL backend once per arm
 *   configuration and freezes every answer, so that afterwards no arm touches a gazetteer.
 *
 *   THE RECORDING MUST BE A SUPERSET OF EVERY ARM'S QUESTIONS. An ablation issues queries the production
 *   walk never issues — `parentFallback: false` alone removes a retry whose key nothing else asks for, and
 *   `adminCoherence: false` changes which nodes get probed at all. A fixture recorded from one arm makes
 *   the others miss, and `replayBackend` raises on a miss rather than hiding it. So the walk runs once per
 *   registered option set and the keys are unioned.
 *
 *   THE WITHHELD VERDICTS ARE STRIPPED HERE, at the only place that ever sees the backend's full answer.
 *   Stripping later would mean a fixture existed, however briefly, that could hand an arm a partly solved
 *   row.
 *
 *   THE WITHHELD-GOLD STRATUM IS WITHHELD AT THE BACKEND, not subtracted afterwards. Removing the gold from
 *   a finished recording changes what the walk would have done: with the gold gone a different candidate
 *   wins, a different parent resolves, and the walk asks questions the recording never captured — measured
 *   as 6 replay misses in 100 withheld rows. Filtering inside the recording makes the walk see exactly what
 *   replay will see, so the recorded keys are the keys replay asks for. Every member of the gold identity
 *   set is filtered, because leaving one member of a place the gazetteer carries twice leaves it
 *   answerable and the stratum measures nothing.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { parseJSONStrict } from "@mailwoman/core/json"
import type { ResolvedPlace, ResolveOpts, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver"

import {
	candidatePool,
	canonicalQueryKey,
	SAME_DATA_SCHEMA_VERSION,
	type SameDataCandidate,
	type SameDataFixtureRow,
	type SameDataLookup,
	type SameDataPanelRow,
	type SameDataQuery,
	WITHHELD_CANDIDATE_FIELDS,
} from "#eval-harness/same-data/fixture"

/**
 * Drop the query-verdict fields a fixture may never carry.
 */
function stripWithheld(place: ResolvedPlace): SameDataCandidate {
	const withheld = new Set<string>(WITHHELD_CANDIDATE_FIELDS)

	return Object.fromEntries(
		Object.entries(place).filter(([field]) => !withheld.has(field))
	) as unknown as SameDataCandidate
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
	withheld: ReadonlySet<string>,
	onWithhold: (count: number) => void
): ResolverBackend {
	return {
		...backend,
		async findPlace(query: SameDataQuery) {
			const raw = await backend.findPlace(query)
			const answer = withheld.size ? raw.filter((place) => !withheld.has(String(place.id))) : raw

			if (withheld.size) {
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
}

export interface RecordResult {
	fixture: SameDataFixtureRow[]
	census: RecordCensus[]
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
		// Named apart from the catch binding, which the lint rules require to be `error`: a same-named outer variable is
		// SHADOWED, the assignment writes to the parameter, and the receipt then reports a clean run over a failed one.
		let recordingError: string | undefined

		let removedGold = 0
		const withheld = new Set(row.goldPresent ? [] : row.gold.placeIDs.map((placeID) => String(placeID)))

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
