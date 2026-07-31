/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode familyRollup} (3b Task 3) — the corporate-family reader. Fixtures are hand-written
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

	it("returns a one-element array for a familyID query, each member carrying node_id/relationship/source plus a distinct_member_count", async () => {
		using db = openMemory()
		await createAllTables(db)
		await seedManifest(db)

		await db
			.insertInto("filer_family")
			.values([
				{
					node_id: FRN_A,
					family_id: FAMILY_ID,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-15",
					valid_from: "2026-01-15",
					valid_to: null,
				},
				{
					node_id: FRN_B,
					family_id: FAMILY_ID,
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
			{ node_id: FRN_A, relationship: FilerRelationship.HoldingCompany, source: "form-499" },
			{ node_id: FRN_B, relationship: FilerRelationship.HoldingCompany, source: "form-499" },
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

		await db
			.insertInto("filer_family")
			.values([
				{
					node_id: FRN_A,
					family_id: HOLDING_FAMILY,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-15",
					valid_from: "2026-01-15",
					valid_to: null,
				},
				{
					node_id: FRN_A,
					family_id: MANAGEMENT_FAMILY,
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
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: null,
				},
				{
					node_id: FRN_A,
					family_id: FAMILY_ID,
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
	 * Task 3 fix round 2. `readFamilyDisplayNames` (`filer-lookup.ts`) finds the SPECIFIC `filer_edge` that implied each
	 * `filer_family` row — matched on `(from_node_id, relationship, source, valid_from)`, the identical tuple
	 * `build-filer.ts`'s `insertFamilyMembership` writes both rows from in lockstep. These fixtures insert that matching
	 * edge by hand, independent of `canonicalizeOrganizationName`'s real behavior (that's exercised by the REAL-builder
	 * test in `filer-lookup.test.ts` instead) — this suite only needs to prove the READER'S join logic.
	 */
	describe("display_names (task 3 fix round 2)", () => {
		const HOLDING_NODE_ONE_SPELLING = `${FilerIdentifierType.HoldingCompanyName}:Solo Spelling Inc`

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
					family_id: FAMILY_ID,
					relationship: FilerRelationship.HoldingCompany,
					source: "form-499",
					source_vintage: "2026-01-01",
					valid_from: "2026-01-01",
					valid_to: null,
				})
				.execute()

			const result = await familyRollup(db, { familyID: FAMILY_ID, asOf: "2026-12-31" })
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
						family_id: FAMILY_ID,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-01-01",
						valid_from: "2026-01-01",
						valid_to: null,
					},
					{
						node_id: FRN_B,
						family_id: FAMILY_ID,
						relationship: FilerRelationship.HoldingCompany,
						source: "form-499",
						source_vintage: "2026-02-01",
						valid_from: "2026-02-01",
						valid_to: null,
					},
				])
				.execute()

			const result = await familyRollup(db, { familyID: FAMILY_ID, asOf: "2026-12-31" })
			expect(result[0]?.display_names).toEqual(["Acme Corp", "Acme Corporation, LLC"].toSorted())
		})
	})
})
