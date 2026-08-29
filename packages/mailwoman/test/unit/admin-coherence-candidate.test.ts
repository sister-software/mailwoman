/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #1717 seam, end to end on the CANDIDATE backend: a fixture candidate.db (built through the
 *   real {@link buildCandidateTable}, ancestors sidecar included) behind the real resolver walk,
 *   with the admin-coherence verdicts read off the resolved tree the way `extractGeocodeResult`
 *   reads them. This is the flip the sidecar exists for — the Weimar-class winner's `region`
 *   verdict moves from `unverifiable` (no ancestry to check) to a DECIDED verdict, while the
 *   ranking itself stays untouched (flag-only: the wrong winner still wins; the verdict now says
 *   so).
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { mkdtemp, rm } from "@mailwoman/platform/fs/promises"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { createWOFResolver } from "@mailwoman/resolver"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite"
import { buildCandidateTable } from "@mailwoman/resolver-wof-sqlite/build-candidate"
import { adminCoherenceField, type AdminCoherenceSourceNode } from "mailwoman/admin-coherence"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const GERMANY = 100
const THURINGEN = 101
const WEIMAR_DE = 102
const USA = 200
const TEXAS = 201
const WEIMAR_US = 202

/**
 * The Weimar defect in miniature: the DE original and a MORE-POPULOUS US namesake, each chained to its own region +
 * country, so a bare population-first "Weimar" answers Texas.
 */
function buildFixtureAdmin(path: string): void {
	const db = new DatabaseSync(path)

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

	db.close()
}

let scratch: string
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

function flatten(roots: readonly AddressNode[]): AddressNode[] {
	const out: AddressNode[] = []
	const stack = [...roots]

	while (stack.length) {
		const n = stack.pop()!
		out.push(n)
		stack.push(...n.children)
	}

	return out
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-coherence-candidate-"))
	const input = join(scratch, "admin.db")
	const candidatePath = join(scratch, "candidate.db")
	buildFixtureAdmin(input)
	await buildCandidateTable({ input, output: candidatePath })
	lookup = new WOFCandidateTableLookup({ databasePath: candidatePath })
})

afterEach(async () => {
	lookup.close()
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

/**
 * Resolve the Weimar tree and read the verdicts the way the geocode assembly does. `adminCoherence: false` pins the
 * #263 re-pick out of the way — this test is about the STAMP and the VERDICT, not about any mechanism that might one
 * day fix the pick.
 */
async function verdictFor(regionValue: string, includeAncestors: boolean) {
	const resolver = createWOFResolver(lookup)

	const resolved = await resolver.resolveTree(tree(node("locality", "Weimar"), node("region", regionValue)), {
		includeAncestors,
		adminCoherence: false,
	})

	const nodes = flatten(resolved.roots) as AdminCoherenceSourceNode[]
	const winner = nodes.find((n) => n.tag === "locality")!

	return { winner, fragment: adminCoherenceField(nodes, winner, undefined) }
}

describe("admin coherence over the candidate backend's ancestors sidecar", () => {
	test("the qualifier the ranking ignored becomes a DECIDED contradiction — the flip from unverifiable", async () => {
		const { winner, fragment } = await verdictFor("Thüringen", true)

		// The ranking is untouched: population-first still answers Weimar, Texas — with the
		// disambiguator in the input. That is the #1717 defect, faithfully reproduced.
		const stamped = winner as AddressNode

		expect(stamped.lat).toBeCloseTo(29.7, 1)

		// But the winner now CARRIES its containment lineage, stamped from the sidecar…
		expect(stamped.metadata?.["ancestors"]).toEqual([
			{ id: TEXAS, placetype: "region", name: "Texas" },
			{ id: USA, placetype: "country", name: "United States" },
		])

		// …so the verdict is decided: the parsed region contradicts the winner's ancestry.
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
