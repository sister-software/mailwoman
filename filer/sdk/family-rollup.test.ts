/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode familyRollup} — the corporate-family reader. Fixtures are hand-written
 *   directly against an in-memory `filer.db` (`filer_family`/`filer_manifest` rows inserted straight through
 *   Kysely), the same convention `filer-lookup.test.ts` uses for its own non-builder fixtures. This suite
 *   covers the general reader contract (asOf scoping, manifest-first, the schema-version guard, the
 *   familyID/nodeID query shapes, the always-array return shape); the two pre-registered §7-3b gates live in
 *   `filer-lookup.test.ts`'s `describe("§7-3b gates")` block instead, since gate 1 is specifically about
 *   `filerLookup`'s `families` field staying structurally distinct from `cluster`.
 *
 *   **Task 3 fix round 1, IMPORTANT-2:** `familyRollup` used to throw when a `nodeID` resolved to more than
 *   one family, on the theory that there was no rule for picking one. The reviewer correctly pointed out
 *   this disagreed with `filerLookup.ts`'s own `families` field, which answers the identical question with
 *   an array — and the builder routinely emits exactly this shape (`build-filer.test.ts`: a filer whose
 *   holding company differs from its management company). `familyRollup` now always returns `FamilyRollup[]`
 *   (0, 1, or more elements) instead of throwing or returning a bare object/`null`.
 *
 *   **Task 3 fix round 2:** `FamilyRollup` gained `display_names` — `family_id` alone is a canonicalized
 *   slug, and the raw holding-/management-company name(s) that produced it were otherwise unrecoverable
 *   through this reader, a real loss for a product surface whose headline output IS "these filers report
 *   holding company H". `createAllTables` now also creates `filer_node`/`filer_edge` (previously unnecessary
 *   here — `familyRollup` touched only `filer_family`/`filer_manifest`), since `display_names` is recovered
 *   by joining back to the specific `filer_edge` row that implied each membership.
 *
 *   **Task 3 fix round 3:** the `display_names` fixtures below derive their `family_id` via the REAL
 *   `mintFamilyID` (`family-id.ts`) rather than an arbitrary constant — round 2's fixtures used a made-up
 *   `family_id` that happened to still round-trip under the (buggy) pre-round-3 join, which is exactly how
 *   that round's CRITICAL went undetected by these tests: a member with two holding-company edges sharing one
 *   provenance tuple had BOTH names attributed to EVERY family that tuple touched.
 *
 *   **Task 3 fix round 4:** the scoping round 3 got by re-canonicalizing edge targets at READ time is now a
 *   plain join on `filer_family.naming_node_id`, the company node the BUILDER recorded as the one whose name
 *   produced each `family_id`. So every `filer_family` insert below carries that column, and the
 *   `display_names` block gains two fixtures round 3's could not express: one member with two same-tuple edges
 *   naming DIFFERENT families (the leak, at reader level, where the previous two tests were insensitive to it),
 *   and an artifact whose persisted `family_id` no longer matches what today's canonicalizer would mint — the
 *   reviewer's reproduction, which used to silently return no names at all. The REAL-builder versions of all of
 *   this (including one filer reporting two spellings of ONE family, the shape that forced `naming_node_id`
 *   into the primary key) live in `filer-lookup.test.ts`.
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { describe, expect, it } from "vitest"

import {
	createFilerEdgeTable,
	createFilerFamilyTable,
	createFilerManifestTable,
	createFilerNodeTable,
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	type FilerDatabase,
	type FilerManifestTable,
} from "../schema.ts"
import { mintFamilyID } from "./family-id.ts"
import { familyRollup } from "./family-rollup.ts"

function openMemory(): DatabaseClient<FilerDatabase> {
	return new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(":memory:") })
}

async function createAllTables(db: DatabaseClient<FilerDatabase>): Promise<void> {
	await createFilerManifestTable(db)
	await createFilerNodeTable(db)
	await createFilerEdgeTable(db)
	await createFilerFamilyTable(db)
}

const MANIFEST: FilerManifestTable = {
	name: "filer",
	version: "2026-Q1",
	schema_version: 2,
	source: "form-499,bdc-provider-list",
	source_vintage: "2026-Q1",
	build_cmd: "mailwoman filer build",
	build_sha: "deadbeef",
	created_at: "2026-01-01T00:00:00Z",
}

async function seedManifest(
	db: DatabaseClient<FilerDatabase>,
	overrides: Partial<FilerManifestTable> = {}
): Promise<void> {
	await db
		.insertInto("filer_manifest")
		.values({ ...MANIFEST, ...overrides })
		.execute()
}

const FAMILY_ID = "holding_company_name:bigco-inc"
// The company node whose raw spelling produced FAMILY_ID (`filer_family.naming_node_id`).
// These reader-contract fixtures write no matching `filer_edge`, so their `display_names` are `[]` either way;
// the column is NOT NULL, so a value is still required on every insert.
const NAMING_NODE_BIGCO = `${FilerIdentifierType.HoldingCompanyName}:BigCo Inc`
const FRN_A = "frn:0001111111"
const FRN_B = "frn:0002222222"

describe("familyRollup — general reader contract", () => {
	it("throws when neither familyID nor nodeID is supplied", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await expect(familyRollup(db, {})).rejects.toThrow(/exactly one of `familyID`, `nodeID`/)
	})

	it("throws when both familyID and nodeID are supplied", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await expect(familyRollup(db, { familyID: FAMILY_ID, nodeID: FRN_A })).rejects.toThrow(
			/exactly one of `familyID`, `nodeID`/
		)
	})

	it("reads the manifest FIRST — throws rather than answering unstamped when it is missing", async () => {
		using db = openMemory()
		await createAllTables(db)
		// Deliberately no manifest row.

		await expect(familyRollup(db, { familyID: FAMILY_ID })).rejects.toThrow(/expected exactly 1/)
	})

	/**
	 * Task 3 fix round 1, IMPORTANT-3: without this guard, an artifact whose manifest predates `filer_family`
	 * (`schema_version` < 2) would surface a raw, unhelpful "no such table: filer_family" the instant the member query
	 * ran — this table is deliberately NEVER created in this fixture, simulating a real pre-Task-1 artifact.
	 */
	it("throws a descriptive, rebuild-pointing error — not a raw 'no such table' — when schema_version predates filer_family", async () => {
		using db = openMemory()
		await createFilerManifestTable(db)
		// filer_family deliberately NOT created — this IS the pre-3b-Task-1 shape being simulated.
		await seedManifest(db, { schema_version: 1 })

		await expect(familyRollup(db, { familyID: FAMILY_ID })).rejects.toThrow(
			/schema_version 1 predates filer_family.*rebuild this artifact/
		)
	})

	it("returns an empty array when the queried familyID has no rows at all", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		const result = await familyRollup(db, { familyID: "holding_company_name:never-existed" })
		expect(result).toEqual([])
	})

	it("returns an empty array when queried by nodeID and the node belongs to no family", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		const result = await familyRollup(db, { nodeID: "frn:0009999999" })
		expect(result).toEqual([])
	})

	it("returns a one-element array for a familyID query, each member carrying node_id/relationship/assertion/match_score/source plus a distinct_member_count", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await db
			.insertInto("filer_family")
			.values([
				{
					node_id: FRN_A,
					family_id: FAMILY_ID,
					naming_node_id: NAMING_NODE_BIGCO,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-15",
					valid_from: "2026-01-15",
					valid_to: null,
				},
				{
					node_id: FRN_B,
					family_id: FAMILY_ID,
					naming_node_id: NAMING_NODE_BIGCO,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-02-01",
					valid_from: "2026-02-01",
					valid_to: null,
				},
			])
			.execute()

		const result = await familyRollup(db, { familyID: FAMILY_ID, asOf: "2026-06-01" })

		expect(result).toHaveLength(1)
		expect(result[0]?.family_id).toBe(FAMILY_ID)

		expect(result[0]?.members).toEqual([
			{
				node_id: FRN_A,
				relationship: FilerRelationship.HoldingCompany,
				assertion: FilerEdgeAssertion.Authoritative,
				match_score: null,
				source: "form-499",
			},
			{
				node_id: FRN_B,
				relationship: FilerRelationship.HoldingCompany,
				assertion: FilerEdgeAssertion.Authoritative,
				match_score: null,
				source: "form-499",
			},
		])

		expect(result[0]?.distinct_member_count).toBe(2)
		expect(result[0]?.as_of).toBe("2026-06-01")
		expect(result[0]?.vintage).toBe(MANIFEST.source_vintage)
	})

	it("resolves the identical rollup whether queried by familyID or by a member's nodeID (single-family case)", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await db
			.insertInto("filer_family")
			.values({
				node_id: FRN_A,
				family_id: FAMILY_ID,
				naming_node_id: NAMING_NODE_BIGCO,
				assertion: FilerEdgeAssertion.Authoritative,
				relationship: FilerRelationship.HoldingCompany,
				source: "form-499",
				source_vintage: "2026-01-15",
				valid_from: "2026-01-15",
				valid_to: null,
			})
			.execute()

		const byFamily = await familyRollup(db, { familyID: FAMILY_ID, asOf: "2026-06-01" })
		const byNode = await familyRollup(db, { nodeID: FRN_A, asOf: "2026-06-01" })

		expect(byNode).toEqual(byFamily)
	})

	/**
	 * Task 3 fix round 1, IMPORTANT-2: this used to be the "throws on ambiguity" test. A node belonging to two families
	 * (holding company != management company) is a normal, builder-emitted shape — see `build-filer.test.ts`'s own
	 * "holding company differs from its management company" fixture — so this now asserts BOTH rollups come back,
	 * matching `filerLookup.ts`'s `families` field's own array contract for the identical question.
	 */
	it("returns ALL families a nodeID belongs to, never throwing on a normal multi-family shape", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		const HOLDING_FAMILY = "holding_company_name:holdco-one"
		const MANAGEMENT_FAMILY = "management_company_name:mgmtco-two"
		const NAMING_NODE_HOLDCO_ONE = `${FilerIdentifierType.HoldingCompanyName}:Holdco One`
		const NAMING_NODE_MGMTCO_TWO = `${FilerIdentifierType.ManagementCompanyName}:MgmtCo Two`

		await db
			.insertInto("filer_family")
			.values([
				{
					node_id: FRN_A,
					family_id: HOLDING_FAMILY,
					naming_node_id: NAMING_NODE_HOLDCO_ONE,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-15",
					valid_from: "2026-01-15",
					valid_to: null,
				},
				{
					node_id: FRN_A,
					family_id: MANAGEMENT_FAMILY,
					naming_node_id: NAMING_NODE_MGMTCO_TWO,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.ManagementCompany,
					source: "form-499",
					source_vintage: "2026-01-15",
					valid_from: "2026-01-15",
					valid_to: null,
				},
			])
			.execute()

		const result = await familyRollup(db, { nodeID: FRN_A, asOf: "2026-06-01" })

		expect(result).toHaveLength(2)

		const familyIDs = result.map((rollup) => rollup.family_id).toSorted()
		expect(familyIDs).toEqual([HOLDING_FAMILY, MANAGEMENT_FAMILY].toSorted())

		for (const rollup of result) {
			expect(rollup.members.some((member) => member.node_id === FRN_A)).toBe(true)
		}
	})

	it("applies the half-open asOf predicate — a membership is excluded before valid_from and on/after valid_to, included strictly within its window", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await db
			.insertInto("filer_family")
			.values({
				node_id: FRN_A,
				family_id: FAMILY_ID,
				naming_node_id: NAMING_NODE_BIGCO,
				assertion: FilerEdgeAssertion.Authoritative,
				relationship: FilerRelationship.HoldingCompany,
				source: "form-499",
				source_vintage: "2026-01-01",
				valid_from: "2026-01-01",
				valid_to: "2026-03-01",
			})
			.execute()

		const before = await familyRollup(db, { familyID: FAMILY_ID, asOf: "2025-12-31" })
		expect(before).toEqual([])

		const within = await familyRollup(db, { familyID: FAMILY_ID, asOf: "2026-02-01" })
		expect(within[0]?.members).toHaveLength(1)

		const atClose = await familyRollup(db, { familyID: FAMILY_ID, asOf: "2026-03-01" })
		expect(atClose).toEqual([])
	})

	it("as_of defaults to today when the caller omits it", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await db
			.insertInto("filer_family")
			.values({
				node_id: FRN_A,
				family_id: FAMILY_ID,
				naming_node_id: NAMING_NODE_BIGCO,
				assertion: FilerEdgeAssertion.Authoritative,
				relationship: FilerRelationship.HoldingCompany,
				source: "form-499",
				source_vintage: "2020-01-01",
				valid_from: "2020-01-01",
				valid_to: null,
			})
			.execute()

		const beforeCall = new Date().toISOString().slice(0, 10)
		const result = await familyRollup(db, { familyID: FAMILY_ID })
		const afterCall = new Date().toISOString().slice(0, 10)

		expect(result[0]?.as_of).toBeDefined()
		expect([beforeCall, afterCall]).toContain(result[0]?.as_of)
	})

	it("member provenance is never collapsed — two different sources asserting the same node's membership both survive, but distinct_member_count still reports 1", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await db
			.insertInto("filer_family")
			.values([
				{
					node_id: FRN_A,
					family_id: FAMILY_ID,
					naming_node_id: NAMING_NODE_BIGCO,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: null,
				},
				{
					node_id: FRN_A,
					family_id: FAMILY_ID,
					naming_node_id: NAMING_NODE_BIGCO,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "bdc-provider-list",
					source_vintage: "2026-Q2",
					valid_from: "2026-06-30",
					valid_to: null,
				},
			])
			.execute()

		const result = await familyRollup(db, { familyID: FAMILY_ID, asOf: "2026-12-31" })
		expect(result[0]?.members).toHaveLength(2)
		expect(result[0]?.distinct_member_count).toBe(1)
	})

	/**
	 * `readFamilyDisplayNames` (`filer-lookup.ts`) reads back the raw spelling behind each `filer_family` row by looking
	 * up the AUTHORITATIVE `filer_edge` from that row's `node_id` to its own stored `naming_node_id`, under the same
	 * `(relationship, source, valid_from)` — the exact edge `build-filer.ts`'s `insertFamilyMembership` wrote the row in
	 * lockstep with. Since task 3 fix round 4 that is a pure JOIN on persisted provenance: the reader no longer calls
	 * `mintFamilyID`/`canonicalizeOrganizationName` at all, so a canonicalizer change in `@mailwoman/record` can no
	 * longer silently empty a shipped artifact's `display_names`.
	 *
	 * These fixtures are hand-written (nodes, edges and family rows inserted directly) and each asserts a spelling the
	 * reader must surface. They are NOT independent of the real canonicalizer, and deliberately so — `FAMILY_ID_SOLO` and
	 * the multi-spelling pair below are minted through the REAL `mintFamilyID`, because round 2's made-up `family_id`
	 * constants are exactly why the cross-family leak reached review. What each test PROVES is the reader's join; what
	 * the real `mintFamilyID` calls establish is that the fixture's premise (these two spellings really do land in one
	 * family) holds for real rather than by assumption. The end-to-end builder versions live in `filer-lookup.test.ts`.
	 */
	describe("display_names — the naming-provenance join", () => {
		const HOLDING_NODE_ONE_SPELLING = `${FilerIdentifierType.HoldingCompanyName}:Solo Spelling Inc`
		// The REAL canonicalized family_id — not an arbitrary constant (using a made-up
		// family_id here is exactly how round 2's fixtures failed to catch the CRITICAL cross-family leak, since
		// the pre-fix join never actually checked whether an edge's target canonicalized to the family_id at all).
		const FAMILY_ID_SOLO = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Solo Spelling Inc")!

		it("a single-spelling family surfaces exactly that one spelling", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: FRN_A, identifier_type: FilerIdentifierType.FRN, identifier_value: "0001111111" },
					{
						node_id: HOLDING_NODE_ONE_SPELLING,
						identifier_type: FilerIdentifierType.HoldingCompanyName,
						identifier_value: "Solo Spelling Inc",
					},
				])
				.execute()

			await db
				.insertInto("filer_edge")
				.values({
					from_node_id: FRN_A,
					to_node_id: HOLDING_NODE_ONE_SPELLING,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: null,
					match_score: null,
					evidence: null,
				})
				.execute()

			await db
				.insertInto("filer_family")
				.values({
					node_id: FRN_A,
					family_id: FAMILY_ID_SOLO,
					naming_node_id: HOLDING_NODE_ONE_SPELLING,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: null,
				})
				.execute()

			const result = await familyRollup(db, { familyID: FAMILY_ID_SOLO, asOf: "2026-12-31" })
			expect(result[0]?.display_names).toEqual(["Solo Spelling Inc"])
		})

		/**
		 * THE RULE (coordinator's explicit requirement — "expose the set, never collapse silently"): two members whose raw
		 * holding-company spellings differ ("Acme Corp" vs "Acme Corporation, LLC" — both reduce to the SAME canonical
		 * `family_id` per `@mailwoman/record`'s `canonicalizeOrganizationName`, verified against a real build in
		 * `filer-lookup.test.ts`) both survive here, sorted — never silently picked down to one.
		 */
		it("a multi-spelling family (two members, two raw spellings sharing one family_id) surfaces BOTH spellings, sorted — never collapsed to one", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const HOLDING_NODE_SPELLING_1 = `${FilerIdentifierType.HoldingCompanyName}:Acme Corp`
			const HOLDING_NODE_SPELLING_2 = `${FilerIdentifierType.HoldingCompanyName}:Acme Corporation, LLC`

			// Confirms the fixture's premise BEFORE using it: these two spellings really do canonicalize to the
			// IDENTICAL family_id (real mintFamilyID, not an arbitrary constant — task 3 fix round 3).
			const familyIDSpelling1 = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Acme Corp")!
			const familyIDSpelling2 = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Acme Corporation, LLC")!
			expect(familyIDSpelling1).toBe(familyIDSpelling2)

			const FAMILY_ID_ACME = familyIDSpelling1

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: FRN_A, identifier_type: FilerIdentifierType.FRN, identifier_value: "0001111111" },
					{ node_id: FRN_B, identifier_type: FilerIdentifierType.FRN, identifier_value: "0002222222" },
					{
						node_id: HOLDING_NODE_SPELLING_1,
						identifier_type: FilerIdentifierType.HoldingCompanyName,
						identifier_value: "Acme Corp",
					},
					{
						node_id: HOLDING_NODE_SPELLING_2,
						identifier_type: FilerIdentifierType.HoldingCompanyName,
						identifier_value: "Acme Corporation, LLC",
					},
				])
				.execute()

			await db
				.insertInto("filer_edge")
				.values([
					{
						from_node_id: FRN_A,
						to_node_id: HOLDING_NODE_SPELLING_1,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
						match_score: null,
						evidence: null,
					},
					{
						from_node_id: FRN_B,
						to_node_id: HOLDING_NODE_SPELLING_2,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-02-01",
						valid_from: "2026-02-01",
						valid_to: null,
						match_score: null,
						evidence: null,
					},
				])
				.execute()

			// Same family_id for both — exactly what canonicalizeOrganizationName would produce for real (verified
			// end-to-end via the REAL builder in filer-lookup.test.ts's own multi-spelling gate test).
			await db
				.insertInto("filer_family")
				.values([
					{
						node_id: FRN_A,
						family_id: FAMILY_ID_ACME,
						naming_node_id: HOLDING_NODE_SPELLING_1,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
					},
					{
						node_id: FRN_B,
						family_id: FAMILY_ID_ACME,
						naming_node_id: HOLDING_NODE_SPELLING_2,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-02-01",
						valid_from: "2026-02-01",
						valid_to: null,
					},
				])
				.execute()

			const result = await familyRollup(db, { familyID: FAMILY_ID_ACME, asOf: "2026-12-31" })
			expect(result[0]?.display_names).toEqual(["Acme Corp", "Acme Corporation, LLC"].toSorted())
		})

		/**
		 * The join under direct unit pressure. Both tests above pass with the naming-provenance join REMOVED — their
		 * fixtures give each member exactly one holding-company edge, so any query keyed on `(from_node_id, relationship,
		 * source, valid_from)` finds the same single row either way. This one does not: ONE member carries TWO edges
		 * sharing that identical 4-tuple, whose targets canonicalize to two DIFFERENT families (the documented decision-6
		 * shape — one FRN filing two 499 rows the same day with conflicting holding companies). Only `naming_node_id` tells
		 * the two apart. Drop it from the query and each family reports the other's name too: a family claiming a holding
		 * company its member never reported to it, the same false-assertion class as 3a's identity leaks. The REAL-builder
		 * versions live in `filer-lookup.test.ts`; this is the reader-level unit that fails first.
		 */
		it("one member, two same-tuple edges naming DIFFERENT families: each family surfaces only its OWN name", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const NODE_NORTH = `${FilerIdentifierType.HoldingCompanyName}:Northwind Holdings`
			const NODE_SOUTH = `${FilerIdentifierType.HoldingCompanyName}:Southgate Group`

			const FAMILY_NORTH = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Northwind Holdings")!
			const FAMILY_SOUTH = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Southgate Group")!

			// The fixture's premise: these are genuinely two families, not one.
			expect(FAMILY_NORTH).not.toBe(FAMILY_SOUTH)

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: FRN_A, identifier_type: FilerIdentifierType.FRN, identifier_value: "0001111111" },
					{
						node_id: NODE_NORTH,
						identifier_type: FilerIdentifierType.HoldingCompanyName,
						identifier_value: "Northwind Holdings",
					},
					{
						node_id: NODE_SOUTH,
						identifier_type: FilerIdentifierType.HoldingCompanyName,
						identifier_value: "Southgate Group",
					},
				])
				.execute()

			// Two edges out of ONE member sharing (from_node_id, relationship, source, valid_from) — distinct rows only
			// because filer_edge's PK carries to_node_id.
			await db
				.insertInto("filer_edge")
				.values([
					{
						from_node_id: FRN_A,
						to_node_id: NODE_NORTH,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
						match_score: null,
						evidence: null,
					},
					{
						from_node_id: FRN_A,
						to_node_id: NODE_SOUTH,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
						match_score: null,
						evidence: null,
					},
				])
				.execute()

			await db
				.insertInto("filer_family")
				.values([
					{
						node_id: FRN_A,
						family_id: FAMILY_NORTH,
						naming_node_id: NODE_NORTH,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
					},
					{
						node_id: FRN_A,
						family_id: FAMILY_SOUTH,
						naming_node_id: NODE_SOUTH,
						assertion: FilerEdgeAssertion.Authoritative,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
					},
				])
				.execute()

			const north = await familyRollup(db, { familyID: FAMILY_NORTH, asOf: "2026-12-31" })
			const south = await familyRollup(db, { familyID: FAMILY_SOUTH, asOf: "2026-12-31" })

			expect(north[0]?.display_names).toEqual(["Northwind Holdings"])
			expect(south[0]?.display_names).toEqual(["Southgate Group"])
		})

		/**
		 * The naming provenance is READ, never re-derived (the reviewer's own reproduction, at the reader level).
		 * `filer.db` ships sealed and separately versioned; `canonicalizeOrganizationName` lives in `@mailwoman/record` and
		 * its designation packs are explicitly documented as extensible. This fixture is what an artifact built by an OLDER
		 * canonicalizer looks like from today's code: the persisted `family_id` is one no current `mintFamilyID` call would
		 * ever produce, while node, edge and membership are all intact. Under round 3's read-time re-canonicalization this
		 * returned `display_names: []` — no error, no warning, the name simply gone. Joining the stored `naming_node_id`
		 * cannot fail this way, because nothing in the read path canonicalizes.
		 */
		it("surfaces the display name even when the persisted family_id no longer matches what the CURRENT canonicalizer would mint", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const NAMING_NODE_DRIFT = `${FilerIdentifierType.HoldingCompanyName}:Drifty Holdings Inc`
			// A family_id one designation token behind — what a canonicalizer built before "inc" joined
			// BASE_DESIGNATIONS would have minted for this very name.
			const STALE_FAMILY_ID = `${FilerIdentifierType.HoldingCompanyName}:drifty holdings inc`

			expect(mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Drifty Holdings Inc")).not.toBe(STALE_FAMILY_ID)

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: FRN_A, identifier_type: FilerIdentifierType.FRN, identifier_value: "0001111111" },
					{
						node_id: NAMING_NODE_DRIFT,
						identifier_type: FilerIdentifierType.HoldingCompanyName,
						identifier_value: "Drifty Holdings Inc",
					},
				])
				.execute()

			await db
				.insertInto("filer_edge")
				.values({
					from_node_id: FRN_A,
					to_node_id: NAMING_NODE_DRIFT,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: null,
					match_score: null,
					evidence: null,
				})
				.execute()

			await db
				.insertInto("filer_family")
				.values({
					node_id: FRN_A,
					family_id: STALE_FAMILY_ID,
					naming_node_id: NAMING_NODE_DRIFT,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: null,
				})
				.execute()

			const result = await familyRollup(db, { familyID: STALE_FAMILY_ID, asOf: "2026-12-31" })
			expect(result[0]?.display_names).toEqual(["Drifty Holdings Inc"])
		})

		/**
		 * "Documented relationships only". `readFamilyDisplayNames` filters the naming edge to `assertion:
		 * "authoritative"`. Nothing in the pipeline emits an INFERRED holding-/management-company edge today —
		 * `cluster-filers.ts` writes `SameEntity` and nothing else — so this cannot be produced through the REAL builder;
		 * it is constructible only by hand, as here. The predicate is there because a `display_names` entry is presented as
		 * a name this family's members actually REPORTED. Surfacing one recovered from a matcher's guess would restate that
		 * guess as a filing, which is the same category of error as 3a's inferred/authoritative conflation — the reason
		 * `inferred_links` is a separate field from `cluster` rather than merged into it.
		 */
		it("ignores an INFERRED naming edge — a display name is a documented report, never a matcher's guess", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const NAMING_NODE_GUESS = `${FilerIdentifierType.HoldingCompanyName}:Guesswork Holdings`
			const FAMILY_GUESS = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Guesswork Holdings")!

			await db
				.insertInto("filer_node")
				.values([
					{ node_id: FRN_A, identifier_type: FilerIdentifierType.FRN, identifier_value: "0001111111" },
					{
						node_id: NAMING_NODE_GUESS,
						identifier_type: FilerIdentifierType.HoldingCompanyName,
						identifier_value: "Guesswork Holdings",
					},
				])
				.execute()

			await db
				.insertInto("filer_edge")
				.values({
					from_node_id: FRN_A,
					to_node_id: NAMING_NODE_GUESS,
					assertion: FilerEdgeAssertion.Inferred,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: null,
					match_score: 0.91,
					evidence: null,
				})
				.execute()

			await db
				.insertInto("filer_family")
				.values({
					node_id: FRN_A,
					family_id: FAMILY_GUESS,
					naming_node_id: NAMING_NODE_GUESS,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: null,
				})
				.execute()

			const result = await familyRollup(db, { familyID: FAMILY_GUESS, asOf: "2026-12-31" })

			// The membership itself still reads back — only the NAME is withheld, because no authoritative edge
			// documents it.
			expect(result[0]?.members).toHaveLength(1)
			expect(result[0]?.display_names).toEqual([])
		})
	})
})
