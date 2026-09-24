/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode familyRollup}, the corporate-family reader. Fixtures insert rows
 *   directly into an in-memory database, as in `filer-lookup.test.ts`. This suite tests
 *   the reader interface and query behavior. The §7-3b criteria are in `filer-lookup.test.ts`,
 *   because criterion 1 concerns the difference between `families` and `cluster`.
 *
 *   A node can belong to multiple families. `familyRollup` always returns an array, whether
 *   there are no matches, one match, or several. This matches the builder and `filerLookup`.
 *
 *   `display_names` comes from joining each family row to its source edge. The tests also
 *   create `filer_node` and `filer_edge`, though the reader only reads `filer_family` and
 *   `filer_manifest`.
 *
 *   The `display_names` fixtures use the real `mintFamilyID`. Arbitrary IDs could let an
 *   incorrect join pass unnoticed, especially when one member has multiple company edges.
 *
 *   Names are matched using the stored `filer_family.naming_node_id`, not by re-canonicalizing
 *   edge targets. Tests cover multiple edges for one member and IDs created by an older
 *   canonicalizer. End-to-end builder tests are in `filer-lookup.test.ts`.
 */

import { isoDate } from "@mailwoman/core/utils"
import { familyRollup } from "@mailwoman/filer/family-rollup"
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
} from "@mailwoman/filer/schema"
import { mintFamilyID } from "@mailwoman/filer/sdk/family-id"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

function openMemory(): DatabaseClient<FilerDatabase> {
	return DatabaseClient.temp<FilerDatabase>()
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
// These reader-interface fixtures write no matching `filer_edge`, so their
// `display_names` are `[]` either way.
// The column is not NULL, so a value is still required on every insert.
const NAMING_NODE_BIGCO = `${FilerIdentifierType.HoldingCompanyName}:BigCo Inc`
const FRN_A = "frn:0001111111"
const FRN_B = "frn:0002222222"

describe("familyRollup — general reader interface", () => {
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
	 * A pre-version-2 artifact has no `filer_family` table.
	 *
	 * This fixture models that case and checks that the reader gives a useful rebuild instruction.
	 */
	it("throws a descriptive, rebuild-pointing error — not a raw 'no such table' — when schema_version predates filer_family", async () => {
		using db = openMemory()
		await createFilerManifestTable(db)
		// filer_family deliberately not created.
		// This is the schema_version 1 shape being simulated.
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
	 * A node belonging to two families (holding company != management company) is a normal,
	 * builder-emitted shape — see `build-filer.test.ts`'s own "holding company differs
	 * from its management company" fixture — so ambiguity is not an error condition here:
	 * both rollups must come back, matching `filerLookup.ts`'s `families` field's
	 * own array interface for the identical question.
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

		const beforeCall = isoDate()
		const result = await familyRollup(db, { familyID: FAMILY_ID })
		const afterCall = isoDate()

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
	 * The reader finds each raw name by joining a family row to its authoritative edge,
	 * using the stored naming node and provenance.
	 *
	 * It does not re-canonicalize names.
	 * These fixtures test the join; real `mintFamilyID` calls verify that the
	 * example spellings belong to the same family.
	 * End-to-end builder tests are in `filer-lookup.test.ts`.
	 */
	describe("display_names — the naming-provenance join", () => {
		const HOLDING_NODE_ONE_SPELLING = `${FilerIdentifierType.HoldingCompanyName}:Solo Spelling Inc`
		// Use a real family ID so an incorrect join cannot pass on a made-up value.
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
		 * Return both spellings when different names belong to the same family.
		 */
		it("a multi-spelling family (two members, two raw spellings sharing one family_id) surfaces BOTH spellings, sorted — never collapsed to one", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const HOLDING_NODE_SPELLING_1 = `${FilerIdentifierType.HoldingCompanyName}:Acme Corp`
			const HOLDING_NODE_SPELLING_2 = `${FilerIdentifierType.HoldingCompanyName}:Acme Corporation, LLC`

			// Confirm both spellings produce the same family ID.
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

			// Both spellings belong to the same family.
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
		 * Checks that each family gets only its own name when a member has two matching edges.
		 */
		it("one member, two same-tuple edges naming DIFFERENT families: each family surfaces only its OWN name", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const NODE_NORTH = `${FilerIdentifierType.HoldingCompanyName}:Northwind Holdings`
			const NODE_SOUTH = `${FilerIdentifierType.HoldingCompanyName}:Southgate Group`

			const FAMILY_NORTH = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Northwind Holdings")!
			const FAMILY_SOUTH = mintFamilyID(FilerIdentifierType.HoldingCompanyName, "Southgate Group")!

			// The fixture's premise: these are genuinely two families rather than one.
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

			// Two edges out of one member sharing (from_node_id, relationship, source, valid_from) —
			// distinct rows only because filer_edge's PK carries to_node_id.
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
		 * Names should still appear when an artifact's family ID came from an older canonicalizer.
		 */
		it("surfaces the display name even when the persisted family_id no longer matches what the CURRENT canonicalizer would mint", async () => {
			using db = openMemory()
			await createAllTables(db)
			await seedManifest(db)

			const NAMING_NODE_DRIFT = `${FilerIdentifierType.HoldingCompanyName}:Drifty Holdings Inc`
			// Simulate an ID stored by an older canonicalizer.
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
		 * Inferred edges are guesses, not reported names, so they must not supply display names.
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

			// The membership itself still reads back — only the name is withheld, because no authoritative edge documents it.
			expect(result[0]?.members).toHaveLength(1)
			expect(result[0]?.display_names).toEqual([])
		})
	})
})
