/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the candidate ancestors sidecar (`candidate_ancestor` + `candidate_interval`,
 *   candidate-ancestors-schema.ts) — the containment lineage behind
 *   {@link WOFCandidateTableLookup.ancestors} and the #1717 admin-coherence check. Builds the Weimar
 *   fixture (the issue's own defect class: a DE locality and a more-populous US namesake, each under
 *   its own region) through the real {@link buildCandidateTable}, then asserts the disciplines the
 *   two consumers depend on:
 *
 *   1. **Chain round-trip** — closure rows are denormalized (placetype + display name + shared-fold
 *      key) and `ancestors()` serves them nearest-first, no join;
 *   2. **Interval truth table** — ancestor / descendant / sibling / self / disjoint verdicts from
 *      the pre/post labels via the shared {@link intervalContains};
 *   3. **Enumerate-with-chains** — every candidate under one `name_key` is enumerable WITH its
 *      chain from the one artifact (the account-layer probe);
 *   4. **DAG canonicalization** — a multi-parent place keeps EVERY parent in the closure rows while
 *      the interval forest commits to the one canonical parent;
 *   5. **Capability honesty** — an artifact without the sidecar reports `ancestors` ABSENT, and a
 *      canonical-parent cycle degrades to unlabeled places, never a hung or corrupt build.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { buildCandidateTable } from "@mailwoman/resolver-wof-sqlite/build-candidate"
import {
	CANDIDATE_ANCESTOR_TABLE,
	CANDIDATE_INTERVAL_TABLE,
	intervalContains,
	type IntervalLabel,
} from "@mailwoman/resolver-wof-sqlite/candidate-ancestors-schema"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite/candidate-lookup"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { allRows, getRow } from "#sqlite-utils"

const GERMANY = 100
const THURINGEN = 101
const WEIMAR_DE = 102
const ERFURT = 103
const WEIMARER_LAND = 105
const USA = 200
const TEXAS = 201
const WEIMAR_US = 202
const LOUISIANA = 301
const AMBIVILLE = 300

/**
 * The Weimar fixture: two same-named localities under different regions (the DE one beneath a county for a 3-link
 * chain), a sibling locality, a two-region DAG place, plus the noise the build must exclude — a self row, a continent
 * row, and an edge to a place with no current spr row.
 */
function buildFixtureAdmin(path: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE place_search (wof_id INTEGER PRIMARY KEY, alt_names TEXT);
		CREATE TABLE place_abbr (id INTEGER PRIMARY KEY, abbr TEXT);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);

		INSERT INTO spr VALUES (${GERMANY}, 'Germany', 'country', 'DE', 51.1, 10.4, 47.3, 5.9, 55.1, 15.0, -1, 0);
		INSERT INTO spr VALUES (${THURINGEN}, 'Thüringen', 'region', 'DE', 50.9, 11.0, 50.2, 9.9, 51.6, 12.7, -1, 0);
		INSERT INTO spr VALUES (${WEIMARER_LAND}, 'Weimarer Land', 'county', 'DE', 50.98, 11.3, 50.8, 11.1, 51.1, 11.5, -1, 0);
		INSERT INTO spr VALUES (${WEIMAR_DE}, 'Weimar', 'locality', 'DE', 50.98, 11.33, 50.9, 11.2, 51.05, 11.4, -1, 0);
		INSERT INTO spr VALUES (${ERFURT}, 'Erfurt', 'locality', 'DE', 50.97, 11.03, 50.9, 10.9, 51.05, 11.1, -1, 0);

		INSERT INTO spr VALUES (${USA}, 'United States', 'country', 'US', 39.0, -97.0, 24.5, -125.0, 49.4, -66.9, -1, 0);
		INSERT INTO spr VALUES (${TEXAS}, 'Texas', 'region', 'US', 31.0, -99.0, 25.8, -106.6, 36.5, -93.5, -1, 0);
		INSERT INTO spr VALUES (${WEIMAR_US}, 'Weimar', 'locality', 'US', 29.7, -96.78, 29.6, -96.9, 29.8, -96.7, -1, 0);
		INSERT INTO spr VALUES (${LOUISIANA}, 'Louisiana', 'region', 'US', 31.0, -92.0, 28.9, -94.0, 33.0, -89.0, -1, 0);
		-- The DAG case: a locality WOF files under two regions at once.
		INSERT INTO spr VALUES (${AMBIVILLE}, 'Ambiville', 'locality', 'US', 31.0, -93.7, 30.9, -93.8, 31.1, -93.6, -1, 0);

		-- The defect's population order: the US namesake outranks the DE original, so a bare
		-- population-first "Weimar" answers Texas — which is what makes the ancestry checkable.
		INSERT INTO place_population VALUES (${WEIMAR_DE}, 65000);
		INSERT INTO place_population VALUES (${WEIMAR_US}, 2000000);
		INSERT INTO place_population VALUES (${ERFURT}, 214000);
		INSERT INTO place_population VALUES (${THURINGEN}, 2100000);
		INSERT INTO place_population VALUES (${TEXAS}, 29000000);

		-- Chains. Weimar DE carries county + region + country; Erfurt goes straight to the region.
		INSERT INTO ancestors VALUES (${WEIMAR_DE}, ${WEIMARER_LAND}, 'county');
		INSERT INTO ancestors VALUES (${WEIMAR_DE}, ${THURINGEN}, 'region');
		INSERT INTO ancestors VALUES (${WEIMAR_DE}, ${GERMANY}, 'country');
		INSERT INTO ancestors VALUES (${WEIMARER_LAND}, ${THURINGEN}, 'region');
		INSERT INTO ancestors VALUES (${WEIMARER_LAND}, ${GERMANY}, 'country');
		INSERT INTO ancestors VALUES (${THURINGEN}, ${GERMANY}, 'country');
		INSERT INTO ancestors VALUES (${ERFURT}, ${THURINGEN}, 'region');
		INSERT INTO ancestors VALUES (${ERFURT}, ${GERMANY}, 'country');
		INSERT INTO ancestors VALUES (${WEIMAR_US}, ${TEXAS}, 'region');
		INSERT INTO ancestors VALUES (${WEIMAR_US}, ${USA}, 'country');
		INSERT INTO ancestors VALUES (${TEXAS}, ${USA}, 'country');
		INSERT INTO ancestors VALUES (${LOUISIANA}, ${USA}, 'country');
		-- The DAG rows: Ambiville under BOTH regions (Texas is the lower id → the canonical pick).
		INSERT INTO ancestors VALUES (${AMBIVILLE}, ${TEXAS}, 'region');
		INSERT INTO ancestors VALUES (${AMBIVILLE}, ${LOUISIANA}, 'region');
		INSERT INTO ancestors VALUES (${AMBIVILLE}, ${USA}, 'country');

		-- Noise the build must exclude: a self row, a continent row (placetypeDepth 0), and an edge
		-- to id 999, which has no current spr row (nothing to denormalize).
		INSERT INTO ancestors VALUES (${WEIMAR_DE}, ${WEIMAR_DE}, 'locality');
		INSERT INTO ancestors VALUES (${WEIMAR_DE}, 998, 'continent');
		INSERT INTO ancestors VALUES (${WEIMAR_DE}, 999, 'region');
	`)
}

let scratch: TemporaryDirectory
let candidatePath: string

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-candidate-ancestors-")
	const input = scratch.resolve("admin.db")
	candidatePath = scratch.resolve("candidate.db")
	buildFixtureAdmin(input)
	await buildCandidateTable({ input, output: candidatePath })
})

afterEach(async () => {
	scratch[Symbol.asyncDispose]()
})

function intervalOf(db: DatabaseClient<WOFDatabase>, id: number): IntervalLabel | undefined {
	return getRow<IntervalLabel>(db.prepare(`SELECT pre, post FROM ${CANDIDATE_INTERVAL_TABLE} WHERE spr_id = ?`), id)
}

describe("the candidate ancestors sidecar", () => {
	test("closure rows round-trip denormalized, nearest-first, under the shared fold", () => {
		using db = new DatabaseClient<WOFDatabase>(candidatePath, { readOnly: true })

		const rows = allRows<{
			depth: number
			parent_spr_id: number
			placetype: string
			parent_name: string
			parent_name_key: string
		}>(
			db.prepare(
				`SELECT a.depth, a.parent_spr_id, pc.placetype AS placetype, a.parent_name, a.parent_name_key
				 FROM ${CANDIDATE_ANCESTOR_TABLE} a JOIN placetype_codes pc ON pc.id = a.parent_placetype_id
				 WHERE a.spr_id = ? ORDER BY a.depth ASC`
			),
			WEIMAR_DE
		)

		// Nearest-first: county → region → country. The self row, the continent row and the edge to
		// the absent place 999 contributed nothing.
		expect(rows.map((r) => r.parent_spr_id)).toEqual([WEIMARER_LAND, THURINGEN, GERMANY])
		expect(rows.map((r) => r.placetype)).toEqual(["county", "region", "country"])
		expect(rows.map((r) => r.depth)).toEqual([1, 2, 3])
		// Denormalized display name + the SHARED normalizeLocalityForKey fold — the same fold the
		// candidate keys and the coherence check use, agreeing by construction.
		expect(rows[1]!.parent_name).toBe("Thüringen")
		expect(rows[1]!.parent_name_key).toBe(normalizeLocalityForKey("Thüringen"))
	})

	test("the reader serves the chain as Ancestor rows, nearest-first and memo-stable", () => {
		using lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		expect(typeof lk.ancestors).toBe("function")

		const chain = lk.ancestors!(WEIMAR_DE)

		expect(chain).toEqual([
			{ id: WEIMARER_LAND, placetype: "county", name: "Weimarer Land" },
			{ id: THURINGEN, placetype: "region", name: "Thüringen" },
			{ id: GERMANY, placetype: "country", name: "Germany" },
		])

		// Memoized: the second read is the same array, and a string id folds to the same place.
		expect(lk.ancestors!(WEIMAR_DE)).toBe(chain)
		expect(lk.ancestors!(String(WEIMAR_US)).map((a) => a.name)).toEqual(["Texas", "United States"])
		// No recorded ancestry (a country) and an unknown id both answer empty, never throw.
		expect(lk.ancestors!(GERMANY)).toEqual([])
		expect(lk.ancestors!(424_242)).toEqual([])
	})

	test("interval containment truth table: ancestor, descendant, sibling, self, disjoint", () => {
		using db = new DatabaseClient<WOFDatabase>(candidatePath, { readOnly: true })

		const germany = intervalOf(db, GERMANY)!
		const thuringen = intervalOf(db, THURINGEN)!
		const weimarDE = intervalOf(db, WEIMAR_DE)!
		const erfurt = intervalOf(db, ERFURT)!
		const texas = intervalOf(db, TEXAS)!
		const weimarUS = intervalOf(db, WEIMAR_US)!

		// ancestor → descendant, at any distance and with no tier knowledge on either side
		expect(intervalContains(thuringen, weimarDE)).toBe(true)
		expect(intervalContains(germany, weimarDE)).toBe(true)
		expect(intervalContains(texas, weimarUS)).toBe(true)
		// descendant does not contain its ancestor
		expect(intervalContains(weimarDE, thuringen)).toBe(false)
		// siblings under one region
		expect(intervalContains(weimarDE, erfurt)).toBe(false)
		expect(intervalContains(erfurt, weimarDE)).toBe(false)
		// self: containment degenerates to identity
		expect(intervalContains(weimarDE, weimarDE)).toBe(true)
		// disjoint across hierarchies — the Weimar-class verdict itself
		expect(intervalContains(thuringen, weimarUS)).toBe(false)
		expect(intervalContains(texas, weimarDE)).toBe(false)

		// Descendant enumeration is a contiguous range scan.
		const descendants = allRows<{ spr_id: number }>(
			db.prepare(`SELECT spr_id FROM ${CANDIDATE_INTERVAL_TABLE} WHERE pre > ? AND post < ? ORDER BY spr_id`),
			thuringen.pre,
			thuringen.post
		)

		expect(descendants.map((d) => d.spr_id)).toEqual([WEIMAR_DE, ERFURT, WEIMARER_LAND])
	})

	test("every candidate under one name_key enumerates WITH its chain from the one artifact (#1722)", () => {
		using db = new DatabaseClient<WOFDatabase>(candidatePath, { readOnly: true })

		const rows = allRows<{
			spr_id: number
			country: string
			parent_name_key: string | null
			parent_placetype: string | null
		}>(
			db.prepare(
				`SELECT c.spr_id, cc.code AS country, a.parent_name_key, pc.placetype AS parent_placetype
				 FROM candidate c
				 JOIN country_codes cc ON cc.id = c.country_id
				 LEFT JOIN ${CANDIDATE_ANCESTOR_TABLE} a ON a.spr_id = c.spr_id
				 LEFT JOIN placetype_codes pc ON pc.id = a.parent_placetype_id
				 WHERE c.name_key = ?
				 ORDER BY c.neg_rank ASC, a.depth ASC`
			),
			normalizeLocalityForKey("Weimar")
		)

		const regionKeyOf = (sprID: number): string | undefined =>
			rows.find((r) => r.spr_id === sprID && r.parent_placetype === "region")?.parent_name_key ?? undefined

		// Both bearers of the key are present — the outranked DE original included — and each is
		// discriminated by its region-class containment, from one probe over one artifact.
		expect(new Set(rows.map((r) => r.spr_id))).toEqual(new Set([WEIMAR_DE, WEIMAR_US]))
		expect(regionKeyOf(WEIMAR_DE)).toBe(normalizeLocalityForKey("Thüringen"))
		expect(regionKeyOf(WEIMAR_US)).toBe(normalizeLocalityForKey("Texas"))
	})

	test("a multi-parent place keeps EVERY parent in the closure rows; the interval forest commits to one", () => {
		using db = new DatabaseClient<WOFDatabase>(candidatePath, { readOnly: true })

		const parents = allRows<{ parent_spr_id: number }>(
			db.prepare(`SELECT parent_spr_id FROM ${CANDIDATE_ANCESTOR_TABLE} WHERE spr_id = ? ORDER BY depth ASC`),
			AMBIVILLE
		)

		// The complete containment record: both regions, then the country. Texas (lower id at the
		// same tier) sorts first, which makes it the canonical depth-1 parent.
		expect(parents.map((p) => p.parent_spr_id)).toEqual([TEXAS, LOUISIANA, USA])

		const ambiville = intervalOf(db, AMBIVILLE)!
		const texas = intervalOf(db, TEXAS)!
		const louisiana = intervalOf(db, LOUISIANA)!

		// The interval verdict is "contained along the CANONICAL hierarchy": true under Texas, false
		// under Louisiana even though the closure rows attest the Louisiana edge. A consumer needing
		// the non-canonical hierarchy consults the closure rows — that is the recorded division of
		// labor, not a defect.
		expect(intervalContains(texas, ambiville)).toBe(true)
		expect(intervalContains(louisiana, ambiville)).toBe(false)

		// One interval row per place — the forest stayed a forest.
		const { n } = getRow<{ n: number }>(
			db.prepare(`SELECT COUNT(*) AS n FROM ${CANDIDATE_INTERVAL_TABLE} WHERE spr_id = ?`),
			AMBIVILLE
		)!

		expect(n).toBe(1)
	})

	test("an artifact without the sidecar reports the capability ABSENT — never [] dressed as an answer", () => {
		// The tests may patch the built (unsealed) fixture directly — the same shape as an older
		// candidate.db that predates the sidecar.
		using db = new DatabaseClient<WOFDatabase>(candidatePath)
		db.exec(`DROP TABLE ${CANDIDATE_ANCESTOR_TABLE}; DROP TABLE ${CANDIDATE_INTERVAL_TABLE};`)

		using lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		expect(lk.ancestors).toBeUndefined()
	})

	test("a canonical-parent cycle degrades to unlabeled places — closure rows kept, no hang, no labels", async () => {
		const input = scratch.resolve("cycle-admin.db")
		const output = scratch.resolve("cycle-candidate.db")
		using db = new DatabaseClient<WOFDatabase>(input)

		// Two localities each naming the other as an ancestor (corrupt source ancestry), beside one
		// healthy chain that must still label.
		db.exec(`
			CREATE TABLE spr (
				id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
				latitude REAL, longitude REAL,
				min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
				is_current INTEGER, is_deprecated INTEGER
			);
			CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
			CREATE TABLE place_search (wof_id INTEGER PRIMARY KEY, alt_names TEXT);
			CREATE TABLE place_abbr (id INTEGER PRIMARY KEY, abbr TEXT);
			CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);

			INSERT INTO spr VALUES (1, 'Loopton', 'locality', 'US', 40.0, -90.0, 39.9, -90.1, 40.1, -89.9, -1, 0);
			INSERT INTO spr VALUES (2, 'Cycleburg', 'locality', 'US', 41.0, -91.0, 40.9, -91.1, 41.1, -90.9, -1, 0);
			INSERT INTO spr VALUES (10, 'Healthy', 'locality', 'US', 42.0, -92.0, 41.9, -92.1, 42.1, -91.9, -1, 0);
			INSERT INTO spr VALUES (11, 'Sane State', 'region', 'US', 42.0, -92.0, 41.0, -93.0, 43.0, -91.0, -1, 0);

			INSERT INTO ancestors VALUES (1, 2, 'locality');
			INSERT INTO ancestors VALUES (2, 1, 'locality');
			INSERT INTO ancestors VALUES (10, 11, 'region');
		`)

		const result = await buildCandidateTable({ input, output })

		// The cycle members keep their closure rows (the record is real) but receive no labels; the
		// healthy chain labels normally (Healthy + Sane State = 2 forest nodes).
		expect(result.ancestorPlaces).toBe(3)
		expect(result.intervalPlaces).toBe(2)

		using built = new DatabaseClient<WOFDatabase>(output, { readOnly: true })

		expect(intervalOf(built, 1)).toBeUndefined()
		expect(intervalOf(built, 2)).toBeUndefined()
		expect(intervalContains(intervalOf(built, 11)!, intervalOf(built, 10)!)).toBe(true)
	})
})
