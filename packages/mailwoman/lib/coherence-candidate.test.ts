/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The candidate backend end to end: a fixture candidate.db built through the real
 *   {@link buildCandidateTable} with its ancestors sidecar, behind the real resolver walk, with the
 *   admin-coherence verdicts read off the resolved tree the way `extractGeocodeResult` reads them.
 *   The sidecar moves the Weimar-class winner's `region` verdict from `unverifiable` to a decided
 *   verdict, while the ranking itself stays untouched. The wrong winner still wins and the verdict
 *   now reports that result.
 */

import { walkNodes, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createWOFResolver } from "@mailwoman/resolver"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite"
import { buildCandidateTable } from "@mailwoman/resolver-wof-sqlite/build/candidate"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { adminCoherenceField, type AdminCoherenceSourceNode } from "#admin-coherence"

const GERMANY = 100
const THURINGEN = 101
const WEIMAR_DE = 102
const USA = 200
const TEXAS = 201
const WEIMAR_US = 202

/**
 * The Weimar defect in miniature: the DE original and a more-populous US namesake,
 * each chained to its own region + country, so a bare population-first "Weimar" answers Texas.
 */
function buildFixtureAdmin(path: PathBuilderLike): void {
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
		INSERT INTO spr VALUES (${WEIMAR_DE}, 'Weimar', 'locality', 'DE', 50.98, 11.33, 50.9, 11.2, 51.05, 11.4, -1, 0);
		INSERT INTO spr VALUES (${USA}, 'United States', 'country', 'US', 39.0, -97.0, 24.5, -125.0, 49.4, -66.9, -1, 0);
		INSERT INTO spr VALUES (${TEXAS}, 'Texas', 'region', 'US', 31.0, -99.0, 25.8, -106.6, 36.5, -93.5, -1, 0);
		INSERT INTO spr VALUES (${WEIMAR_US}, 'Weimar', 'locality', 'US', 29.7, -96.78, 29.6, -96.9, 29.8, -96.7, -1, 0);

		INSERT INTO place_population VALUES (${WEIMAR_DE}, 65000);
		INSERT INTO place_population VALUES (${WEIMAR_US}, 2000000);
		INSERT INTO place_population VALUES (${THURINGEN}, 2100000);
		INSERT INTO place_population VALUES (${TEXAS}, 29000000);

		INSERT INTO ancestors VALUES (${WEIMAR_DE}, ${THURINGEN}, 'region');
		INSERT INTO ancestors VALUES (${WEIMAR_DE}, ${GERMANY}, 'country');
		INSERT INTO ancestors VALUES (${THURINGEN}, ${GERMANY}, 'country');
		INSERT INTO ancestors VALUES (${WEIMAR_US}, ${TEXAS}, 'region');
		INSERT INTO ancestors VALUES (${WEIMAR_US}, ${USA}, 'country');
		INSERT INTO ancestors VALUES (${TEXAS}, ${USA}, 'country');
	`)
}

let scratch: TemporaryDirectory
let lookup: WOFCandidateTableLookup

const node = (tag: string, value: string): AddressNode => ({
	tag: tag as AddressNode["tag"],
	value,
	start: 0,
	end: value.length,
	confidence: 0.9,
	children: [],
})

const tree = (...roots: AddressNode[]): AddressTree => ({ raw: roots.map((r) => r.value).join(", "), roots })

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-coherence-candidate-")
	const input = scratch.path("admin.db")
	const candidatePath = scratch.path("candidate.db")
	buildFixtureAdmin(input)
	await buildCandidateTable({ input, output: candidatePath })
	lookup = new WOFCandidateTableLookup({ databasePath: candidatePath })
})

afterEach(async () => {
	lookup[Symbol.dispose]()
	await scratch[Symbol.asyncDispose]()
})

/**
 * Resolve the Weimar tree and read the verdicts the way the geocode assembly does.
 *
 * `adminCoherence: false` keeps the re-pick out of the way, since this test
 * is about the stamp and the verdict.
 */
async function verdictFor(regionValue: string, includeAncestors: boolean) {
	const resolver = createWOFResolver(lookup)

	const resolved = await resolver.resolveTree(tree(node("locality", "Weimar"), node("region", regionValue)), {
		includeAncestors,
		adminCoherence: false,
	})

	const nodes = [...walkNodes(resolved.roots)] as AdminCoherenceSourceNode[]
	const winner = nodes.find((n) => n.tag === "locality")!

	return { winner, fragment: adminCoherenceField(nodes, winner, undefined) }
}

describe("admin coherence over the candidate backend's ancestors sidecar", () => {
	test("the qualifier the ranking ignored becomes a DECIDED contradiction — the flip from unverifiable", async () => {
		const { winner, fragment } = await verdictFor("Thüringen", true)

		// The ranking is untouched: population-first still answers Weimar, Texas,
		// with the disambiguator in the input.
		const stamped = winner as AddressNode

		expect(stamped.lat).toBeCloseTo(29.7, 1)

		expect(stamped.metadata?.["ancestors"]).toEqual([
			{ id: TEXAS, placetype: "region", name: "Texas" },
			{ id: USA, placetype: "country", name: "United States" },
		])

		expect(fragment.admin_coherence!.region).toBe("contradicted")
	})

	test("without the stamp the same winner reads unverifiable — the pre-sidecar standing state", async () => {
		const { fragment } = await verdictFor("Thüringen", false)

		expect(fragment.admin_coherence!.region).toBe("unverifiable")
	})

	test("a qualifier the ancestry vouches for reads confirmed", async () => {
		const { fragment } = await verdictFor("Texas", true)

		expect(fragment.admin_coherence!.region).toBe("confirmed")
	})
})
