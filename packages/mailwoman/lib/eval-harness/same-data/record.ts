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
		// Not `error`: the catch binding below takes that name, and a same-named outer variable is shadowed — the
		// assignment would write to the parameter and the receipt would report a clean run over a failed one.
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
