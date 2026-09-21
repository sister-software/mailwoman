/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The frozen candidate fixture every arm of the same-data benchmark reads (#2261): the row interface, the
 *   replay key, the digests, and the validator that refuses a fixture two arms could read differently.
 *
 *   Evidence is keyed per lookup rather than per row: one input costs the walk up to `maxLookups` backend
 *   calls (default 10), each with its own text, placetype and scope. So a row holds a map from canonical
 *   query to answer, plus the pool — the deduplicated union of every answer, which is the ordered candidate
 *   set the row offered. Which of the pool an arm consults is its own query policy and part of what is being
 *   measured. the pool is what must be equal, and `assertEqualEvidence` checks that.
 *
 *   `replayBackend` raises on a key it does not hold rather than answering `[]`. An empty answer is a state
 *   the resolver absorbs silently, so the arm would report an abstention the fixture produced.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"

import { canonicalJSON, definitionContentHash } from "#eval-harness/preregistration"

/**
 * The row interface's version.
 *
 * A change to the shape of a fixture row bumps it, and a scorer refuses a
 * fixture whose version it does not know.
 * A silently reinterpreted field is the failure this number exists to prevent.
 */
export const SAME_DATA_SCHEMA_VERSION = 1

/**
 * Candidate fields the fixture never carries, because each is a verdict the backend
 * already computed about the query rather than a fact about the place.
 *
 * Carrying one hands every arm a partly solved row.
 *
 * This tuple is the one home: {@link SameDataCandidate} is derived from it,
 * and the frozen definition's own list is audited against it, so the type
 * and the ruler cannot disagree about what equal evidence means.
 */
export const WITHHELD_CANDIDATE_FIELDS = [
	"containedByQualifier",
	"mismatch",
	"regionScopeMiss",
	"resolutionQuality",
	"variantAliasExempted",
] as const

/**
 * One candidate as the fixture carries it: a `ResolvedPlace` minus the withheld verdicts.
 */
export type SameDataCandidate = Omit<ResolvedPlace, (typeof WITHHELD_CANDIDATE_FIELDS)[number]>

/**
 * The `findPlace` query, as the fixture keys on it.
 */
export type SameDataQuery = Parameters<ResolverBackend["findPlace"]>[0]

/**
 * One recorded backend answer.
 */
export interface SameDataLookup {
	/**
	 * The canonical query key — {@link canonicalQueryKey} of {@link SameDataLookup.query}.
	 *
	 * Stored beside the query rather than derived at read time so a hand-edited query
	 * is caught by the validator instead of silently re-keying.
	 */
	key: string
	query: SameDataQuery
	candidates: SameDataCandidate[]
}

/**
 * The gold entity for one row: a GeoNames row, and the WOF id the gazetteer's
 * `gn:id` concordance links it to.
 */
export interface SameDataGold {
	geonameid: string
	/**
	 * The distinct WOF ids that denote this place, ascending.
	 *
	 * A SET because the gazetteer carries 21 of its 10,738 coherently-joined `cities15000.txt` places twice.
	 *
	 * A selection naming any member is correct.
	 * Grading against one arbitrary member would measure which duplicate an arm returned.
	 */
	placeIDs: number[]
	name: string
	country: string
	admin1: string
	lat: number
	lon: number
	population: number
}

/**
 * One panel row: the question and its answer key.
 *
 * Carries no candidates — those live in the candidate fixture, so the panel stays
 * readable and the evidence stays one file.
 */
export interface SameDataPanelRow {
	id: string
	stratum: string
	/**
	 * The raw query, stored exactly as evaluated.
	 *
	 * No arm normalizes before the fixture is read.
	 */
	query: string
	gold: SameDataGold
	/**
	 * False in the withheld-gold stratum, where the recorder filtered every member of
	 * the gold identity set out of the backend's answers as it recorded.
	 *
	 * Drives which denominator the row counts in, and is never inferred from an empty pool.
	 * A pool can be empty because the gazetteer holds nothing, which is a different fact.
	 */
	goldPresent: boolean
	source: {
		register: string
		license: string
		attribution: string
	}
}

/**
 * One row's frozen evidence.
 */
export interface SameDataFixtureRow {
	id: string
	schemaVersion: number
	/**
	 * The frozen parse.
	 *
	 * Both resolver arms walk this tree rather than parsing, which puts the parser outside the scored unit.
	 * The claim is about resolution.
	 *
	 * The model version that produced it is recorded in the run receipt.
	 */
	tree: AddressTree
	lookups: SameDataLookup[]
	/**
	 * The deduplicated union of every lookup's candidates, in canonical order:
	 * the ordered candidate set this row offered.
	 *
	 * Sorted by id as a string, which is a total order over both id forms `ResolvedPlace` allows.
	 */
	pool: SameDataCandidate[]
}

/**
 * The replay key for one backend query.
 *
 * Canonical JSON, so a key cannot move because a caller built the query object in a different field order.
 */
export function canonicalQueryKey(query: SameDataQuery): string {
	return canonicalJSON(query)
}

/**
 * The deduplicated, canonically ordered union of every candidate a row's lookups returned.
 *
 * First writer wins per id: the same place answered under two scopes is one candidate,
 * and the earlier answer is the one the walk saw first.
 */
export function candidatePool(lookups: readonly SameDataLookup[]): SameDataCandidate[] {
	const byID = new Map<string, SameDataCandidate>()

	for (const lookup of lookups) {
		for (const candidate of lookup.candidates) {
			const key = String(candidate.id)

			if (!byID.has(key)) {
				byID.set(key, candidate)
			}
		}
	}

	return [...byID.entries()]
		.toSorted(([left], [right]) => compareByCodePoint(left, right))
		.map(([, candidate]) => candidate)
}

/**
 * One row's evidence digest.
 *
 * The value every arm's receipt carries, and the value the validator compares across arms.
 */
export function fixtureRowDigest(row: SameDataFixtureRow): string {
	return definitionContentHash({
		id: row.id,
		schemaVersion: row.schemaVersion,
		tree: row.tree,
		lookups: row.lookups,
		pool: row.pool,
	})
}

/**
 * The whole fixture's digest, over rows in committed order.
 */
export function fixtureDigest(rows: readonly SameDataFixtureRow[]): string {
	return definitionContentHash(rows.map((row) => fixtureRowDigest(row)))
}

/**
 * A problem the fixture carries, named so a refusal reads as an instruction.
 */
export interface FixtureProblem {
	rowID: string
	problem: string
}

/**
 * Whether the fixture is one every arm must read identically.
 *
 * Six refusals: an unknown schema version, a duplicate row id, a withheld verdict field
 * present on a candidate, a lookup key that does not match its own query, a pool that is not
 * the canonical union of the lookups, and a panel row with no fixture row (or the reverse).
 * Each is a way two arms could end up reading different evidence while both reporting success.
 */
export function validateFixture(
	panel: readonly SameDataPanelRow[],
	fixture: readonly SameDataFixtureRow[]
): FixtureProblem[] {
	const problems: FixtureProblem[] = []
	const seen = new Set<string>()
	const fixtureByID = new Map(fixture.map((row) => [row.id, row]))

	for (const row of fixture) {
		if (seen.has(row.id)) {
			problems.push({ rowID: row.id, problem: "row id is used twice — ids name rows in output" })
		}

		seen.add(row.id)

		if (row.schemaVersion !== SAME_DATA_SCHEMA_VERSION) {
			problems.push({
				rowID: row.id,
				problem: `schemaVersion ${row.schemaVersion} — this reader knows ${SAME_DATA_SCHEMA_VERSION}`,
			})
		}

		for (const lookup of row.lookups) {
			const expected = canonicalQueryKey(lookup.query)

			if (lookup.key !== expected) {
				problems.push({ rowID: row.id, problem: `lookup key ${lookup.key} does not match its query (${expected})` })
			}

			for (const candidate of lookup.candidates) {
				for (const field of WITHHELD_CANDIDATE_FIELDS) {
					if (field in candidate) {
						problems.push({
							rowID: row.id,
							problem: `candidate ${String(candidate.id)} carries withheld field ${field} — it is a verdict about the query, not a fact about the place`,
						})
					}
				}
			}
		}

		const expectedPool = candidatePool(row.lookups)

		if (canonicalJSON(expectedPool) !== canonicalJSON(row.pool)) {
			problems.push({
				rowID: row.id,
				problem:
					"pool is not the canonical union of the lookups — the ordered candidate set is what every arm is judged to have received",
			})
		}
	}

	for (const row of panel) {
		if (!fixtureByID.has(row.id)) {
			problems.push({ rowID: row.id, problem: "panel row has no fixture row" })
		}
	}

	const panelIDs = new Set(panel.map((row) => row.id))

	for (const row of fixture) {
		if (!panelIDs.has(row.id)) {
			problems.push({ rowID: row.id, problem: "fixture row has no panel row" })
		}
	}

	return problems
}

/**
 * What one arm observed of one row's evidence.
 * The receipt the equality check reads.
 */
export interface ArmEvidenceObservation {
	arm: string
	rowID: string
	rowDigest: string
	poolSize: number
	candidateIDs: string[]
	candidateFields: string[]
}

/**
 * Whether every arm read the same evidence for every row.
 *
 * Compares the row digest, the pool size, the candidate id set and the candidate field-name set,
 * and reports the first arm as the reference so a difference names both sides.
 * This is the check the brief's acceptance criterion asks for, and it runs over what
 * the arms actually read rather than over the file they were handed.
 */
export function assertEqualEvidence(observations: readonly ArmEvidenceObservation[]): FixtureProblem[] {
	const problems: FixtureProblem[] = []
	const byRow = new Map<string, ArmEvidenceObservation[]>()

	for (const observation of observations) {
		const bucket = byRow.get(observation.rowID) ?? []

		bucket.push(observation)
		byRow.set(observation.rowID, bucket)
	}

	for (const [rowID, bucket] of byRow) {
		const [reference, ...rest] = bucket

		if (!reference) continue

		for (const other of rest) {
			if (other.rowDigest !== reference.rowDigest) {
				problems.push({
					rowID,
					problem: `${other.arm} read fixture digest ${other.rowDigest}, ${reference.arm} read ${reference.rowDigest}`,
				})
			}

			if (other.poolSize !== reference.poolSize) {
				problems.push({
					rowID,
					problem: `${other.arm} saw ${other.poolSize} candidates, ${reference.arm} saw ${reference.poolSize}`,
				})
			}

			if (other.candidateIDs.join(",") !== reference.candidateIDs.join(",")) {
				problems.push({ rowID, problem: `${other.arm} and ${reference.arm} saw different candidate ids` })
			}

			if (other.candidateFields.join(",") !== reference.candidateFields.join(",")) {
				problems.push({ rowID, problem: `${other.arm} and ${reference.arm} saw different candidate field names` })
			}
		}
	}

	return problems
}

/**
 * The evidence observation for one row, as an arm records it before resolving.
 */
export function observeEvidence(arm: string, row: SameDataFixtureRow): ArmEvidenceObservation {
	const fields = new Set<string>()

	for (const candidate of row.pool) {
		for (const field of Object.keys(candidate)) {
			fields.add(field)
		}
	}

	return {
		arm,
		rowID: row.id,
		rowDigest: fixtureRowDigest(row),
		poolSize: row.pool.length,
		candidateIDs: row.pool.map((candidate) => String(candidate.id)),
		candidateFields: [...fields].toSorted(compareByCodePoint),
	}
}

/**
 * A backend that answers only from the fixture.
 *
 * A key the fixture does not hold raises **and** is appended to `misses`.
 * Both are needed, and the second is the one that matters: `resolveTree` catches a
 * backend throw on purpose — "a backend failure should not abort the whole tree walk" —
 * records `backend_error` on the trace and emits `picked: null`.
 *
 * So a raise alone reaches the arm as an abstention, and the arm would report the
 * resolver refusing when it was the fixture that refused.
 * The caller reads `misses` after the walk and turns a non-empty list into a harness error,
 * which the scorer excludes from every metric.
 */
export function replayBackend(row: SameDataFixtureRow, misses: string[] = []): ResolverBackend {
	const byKey = new Map(row.lookups.map((lookup) => [lookup.key, lookup.candidates]))

	return {
		async findPlace(query) {
			const key = canonicalQueryKey(query)
			const hit = byKey.get(key)

			if (!hit) {
				misses.push(key)

				throw new Error(
					`same-data fixture: row ${row.id} holds no answer for ${key} — the recording is not a superset of this arm's questions, so re-record with this arm's options included`
				)
			}

			// A fresh array and a fresh object per candidate.
			// The array copy stops an in-place sort inside the walk from reordering the frozen evidence.
			// The per-candidate copy stops the walk writing to it, because the resolver stamps
			// verdict fields onto the candidates it is handed (`containedByQualifier`, `mismatch`).
			// A shared object would leave one arm reading evidence another arm edited.
			return hit.map((candidate) => ({ ...candidate }))
		},
	}
}
