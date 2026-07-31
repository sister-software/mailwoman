/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { describe, expect, it } from "vitest"

import {
	createFilerAttributeTable,
	createFilerClusterTable,
	createFilerEdgeTable,
	createFilerEdgeToNodeIndex,
	createFilerFamilyIndex,
	createFilerFamilyTable,
	createFilerManifestTable,
	createFilerNodeTable,
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	readFilerManifest,
	type FilerDatabase,
	type FilerEdgeTable,
	type FilerFamilyTable,
} from "./schema.ts"

function openMemory(): DatabaseClient<FilerDatabase> {
	return new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(":memory:") })
}

async function createAllTables(db: DatabaseClient<FilerDatabase>): Promise<void> {
	await createFilerNodeTable(db)
	await createFilerEdgeTable(db)
	await createFilerEdgeToNodeIndex(db)
	await createFilerAttributeTable(db)
	await createFilerClusterTable(db)
	await createFilerFamilyTable(db)
	await createFilerFamilyIndex(db)
	await createFilerManifestTable(db)
}

const FRN_NODE_ID = `${FilerIdentifierType.FRN}:0001753557`
const SPIN_NODE_ID = `${FilerIdentifierType.SPIN}:143123456`

async function insertCrosswalkNodes(db: DatabaseClient<FilerDatabase>): Promise<void> {
	await db
		.insertInto("filer_node")
		.values([
			{ node_id: FRN_NODE_ID, identifier_type: FilerIdentifierType.FRN, identifier_value: "0001753557" },
			{ node_id: SPIN_NODE_ID, identifier_type: FilerIdentifierType.SPIN, identifier_value: "143123456" },
		])
		.execute()
}

const AUTHORITATIVE_EDGE: FilerEdgeTable = {
	from_node_id: FRN_NODE_ID,
	to_node_id: SPIN_NODE_ID,
	assertion: FilerEdgeAssertion.Authoritative,
	relationship: FilerRelationship.SameEntity,
	source: "form-499",
	source_vintage: "2026-Q1",
	valid_from: "2026-01-01",
	valid_to: null,
	match_score: null,
	evidence: null,
}

const HOLDING_NODE_ID = `${FilerIdentifierType.HoldingCompanyName}:Acme Holdings Inc`
const FAMILY_ID = HOLDING_NODE_ID

const FAMILY_ROW: FilerFamilyTable = {
	node_id: FRN_NODE_ID,
	family_id: FAMILY_ID,
	naming_node_id: HOLDING_NODE_ID,
	relationship: FilerRelationship.HoldingCompany,
	source: "form-499",
	source_vintage: "2026-Q1",
	valid_from: "2026-01-01",
	valid_to: null,
}

describe("filer schema", () => {
	it("creates all six filer.db tables, each accepting and returning a row", async () => {
		using db = openMemory()
		await createAllTables(db)
		await insertCrosswalkNodes(db)

		const node = await db.selectFrom("filer_node").selectAll().where("node_id", "=", FRN_NODE_ID).executeTakeFirst()
		expect(node?.identifier_type).toBe(FilerIdentifierType.FRN)

		await db.insertInto("filer_edge").values(AUTHORITATIVE_EDGE).execute()
		const edge = await db.selectFrom("filer_edge").selectAll().executeTakeFirst()
		expect(edge?.source).toBe("form-499")
		expect(edge?.relationship).toBe(FilerRelationship.SameEntity)

		await db
			.insertInto("filer_attribute")
			.values({
				node_id: FRN_NODE_ID,
				key: "brand_name",
				value: "Acme Telecom",
				source: "form-499",
				source_vintage: "2026-Q1",
			})
			.execute()

		const attribute = await db.selectFrom("filer_attribute").selectAll().executeTakeFirst()
		expect(attribute?.value).toBe("Acme Telecom")

		await db
			.insertInto("filer_cluster")
			.values({ node_id: FRN_NODE_ID, cluster_id: "cluster-1", assertion: FilerEdgeAssertion.Authoritative })
			.execute()

		const cluster = await db.selectFrom("filer_cluster").selectAll().executeTakeFirst()
		expect(cluster?.cluster_id).toBe("cluster-1")

		await db.insertInto("filer_family").values(FAMILY_ROW).execute()
		const family = await db.selectFrom("filer_family").selectAll().executeTakeFirst()
		expect(family?.family_id).toBe(FAMILY_ID)
		expect(family?.relationship).toBe(FilerRelationship.HoldingCompany)

		await db
			.insertInto("filer_manifest")
			.values({
				name: "filer",
				version: "0.1.0",
				schema_version: 1,
				source: "form-499,bdc-provider-list",
				source_vintage: "2026-Q1",
				build_cmd: "mailwoman filer build",
				build_sha: "deadbeef",
				created_at: "2026-07-31T00:00:00Z",
			})
			.execute()

		const manifest = await db.selectFrom("filer_manifest").selectAll().executeTakeFirst()
		expect(manifest?.name).toBe("filer")
	})

	it("round-trips a typed edge", async () => {
		using db = openMemory()
		await createAllTables(db)
		await insertCrosswalkNodes(db)

		await db.insertInto("filer_edge").values(AUTHORITATIVE_EDGE).execute()

		const row = await db.selectFrom("filer_edge").selectAll().executeTakeFirstOrThrow()
		expect(row).toEqual(AUTHORITATIVE_EDGE)
	})

	it("keeps two sources' assertions of the same relationship as separate rows", async () => {
		using db = openMemory()
		await createAllTables(db)
		await insertCrosswalkNodes(db)

		await db.insertInto("filer_edge").values(AUTHORITATIVE_EDGE).execute()

		await db
			.insertInto("filer_edge")
			.values({
				...AUTHORITATIVE_EDGE,
				assertion: FilerEdgeAssertion.Inferred,
				source: "bdc-provider-list",
				match_score: 0.92,
				evidence: JSON.stringify({ nameSimilarity: 0.92 }),
			})
			.execute()

		const rows = await db.selectFrom("filer_edge").selectAll().execute()
		expect(rows).toHaveLength(2)
	})

	it("keeps a later vintage of the same source as a separate row (revision, not clobber)", async () => {
		using db = openMemory()
		await createAllTables(db)
		await insertCrosswalkNodes(db)

		await db.insertInto("filer_edge").values(AUTHORITATIVE_EDGE).execute()

		await db
			.insertInto("filer_edge")
			.values({ ...AUTHORITATIVE_EDGE, source_vintage: "2026-Q2", valid_from: "2026-04-01" })
			.execute()

		const rows = await db.selectFrom("filer_edge").selectAll().execute()
		expect(rows).toHaveLength(2)
	})

	it("rejects a duplicate insert sharing the same (from, to, source, valid_from) tuple", async () => {
		using db = openMemory()
		await createAllTables(db)
		await insertCrosswalkNodes(db)

		await db.insertInto("filer_edge").values(AUTHORITATIVE_EDGE).execute()

		await expect(db.insertInto("filer_edge").values(AUTHORITATIVE_EDGE).execute()).rejects.toThrow(
			/UNIQUE constraint failed/
		)
	})

	it("rejects a second insert at the same (from, to, source, valid_from) tuple even when it asserts a DIFFERENT relationship (decision 1, 2: a contradiction to reject, not a plurality to store)", async () => {
		using db = openMemory()
		await createAllTables(db)
		await insertCrosswalkNodes(db)

		await db.insertInto("filer_edge").values(AUTHORITATIVE_EDGE).execute()

		// Same source, same pair, same valid_from — only `relationship` differs. `relationship` is deliberately NOT
		// part of the composite PK (see createFilerEdgeTable's docstring), so this must still collide on the PK and
		// be rejected, never silently stored as a second, contradictory row.
		await expect(
			db
				.insertInto("filer_edge")
				.values({ ...AUTHORITATIVE_EDGE, relationship: FilerRelationship.HoldingCompany })
				.execute()
		).rejects.toThrow(/UNIQUE constraint failed/)
	})

	it("finds in-edges by to_node_id via the secondary index", async () => {
		using db = openMemory()
		await createAllTables(db)
		await insertCrosswalkNodes(db)
		await db.insertInto("filer_edge").values(AUTHORITATIVE_EDGE).execute()

		const rows = await db.selectFrom("filer_edge").selectAll().where("to_node_id", "=", SPIN_NODE_ID).execute()
		expect(rows).toHaveLength(1)
	})

	describe("filer_edge.relationship", () => {
		it("rejects an empty string", async () => {
			using db = openMemory()
			await createAllTables(db)
			await insertCrosswalkNodes(db)

			await expect(
				db
					.insertInto("filer_edge")
					.values({ ...AUTHORITATIVE_EDGE, relationship: "" })
					.execute()
			).rejects.toThrow(/CHECK constraint failed/)
		})

		it("rejects a whitespace-only string (not just empty)", async () => {
			using db = openMemory()
			await createAllTables(db)
			await insertCrosswalkNodes(db)

			await expect(
				db
					.insertInto("filer_edge")
					.values({ ...AUTHORITATIVE_EDGE, relationship: "   " })
					.execute()
			).rejects.toThrow(/CHECK constraint failed/)
		})
	})

	describe("filer_family", () => {
		it("round-trips a family row", async () => {
			using db = openMemory()
			await createAllTables(db)
			await insertCrosswalkNodes(db)

			await db.insertInto("filer_family").values(FAMILY_ROW).execute()

			const row = await db.selectFrom("filer_family").selectAll().executeTakeFirstOrThrow()
			expect(row).toEqual(FAMILY_ROW)
		})

		it("keeps two sources' family assertions for the same (node_id, family_id) pair as separate rows", async () => {
			using db = openMemory()
			await createAllTables(db)
			await insertCrosswalkNodes(db)

			await db.insertInto("filer_family").values(FAMILY_ROW).execute()

			await db
				.insertInto("filer_family")
				.values({ ...FAMILY_ROW, source: "bdc-provider-list" })
				.execute()

			const rows = await db.selectFrom("filer_family").selectAll().execute()
			expect(rows).toHaveLength(2)
		})

		it("keeps a later vintage of the same source as a separate row (revision, not clobber)", async () => {
			using db = openMemory()
			await createAllTables(db)
			await insertCrosswalkNodes(db)

			await db.insertInto("filer_family").values(FAMILY_ROW).execute()

			await db
				.insertInto("filer_family")
				.values({ ...FAMILY_ROW, source_vintage: "2026-Q2", valid_from: "2026-04-01" })
				.execute()

			const rows = await db.selectFrom("filer_family").selectAll().execute()
			expect(rows).toHaveLength(2)
		})

		it("rejects a duplicate insert sharing the same (node_id, family_id, naming_node_id, source, valid_from) tuple", async () => {
			using db = openMemory()
			await createAllTables(db)
			await insertCrosswalkNodes(db)

			await db.insertInto("filer_family").values(FAMILY_ROW).execute()

			await expect(db.insertInto("filer_family").values(FAMILY_ROW).execute()).rejects.toThrow(
				/UNIQUE constraint failed/
			)
		})

		it("rejects a second insert at the same (node_id, family_id, naming_node_id, source, valid_from) tuple even when it asserts a DIFFERENT relationship", async () => {
			using db = openMemory()
			await createAllTables(db)
			await insertCrosswalkNodes(db)

			await db.insertInto("filer_family").values(FAMILY_ROW).execute()

			await expect(
				db
					.insertInto("filer_family")
					.values({ ...FAMILY_ROW, relationship: FilerRelationship.ParentCompany })
					.execute()
			).rejects.toThrow(/UNIQUE constraint failed/)
		})

		/**
		 * Task 3 fix round 4, the counterpart to the two tests above — and the reason `naming_node_id` is IN the primary
		 * key rather than a payload column beside it. `relationship` is excluded from the key because two values for one
		 * pair at one instant are a CONTRADICTION; two `naming_node_id`s are not. `"Acme Holdings Inc"` and `"ACME
		 * HOLDINGS, INC."` canonicalize to one `family_id`, so a filer that reported both spellings (two 499 rows the same
		 * day, or one `bdcProviderID` on two provider-list rows) produces two rows differing in nothing else. Narrow the
		 * key and the builder's `INSERT OR IGNORE` drops the second, taking that spelling's display name with it before any
		 * reader runs.
		 */
		it("keeps two DIFFERENT naming_node_ids for the same (node_id, family_id, source, valid_from) tuple as separate rows — the multi-spelling plurality", async () => {
			using db = openMemory()
			await createAllTables(db)
			await insertCrosswalkNodes(db)

			await db.insertInto("filer_family").values(FAMILY_ROW).execute()

			await db
				.insertInto("filer_family")
				.values({ ...FAMILY_ROW, naming_node_id: `${FilerIdentifierType.HoldingCompanyName}:ACME HOLDINGS, INC.` })
				.execute()

			const rows = await db.selectFrom("filer_family").selectAll().where("family_id", "=", FAMILY_ID).execute()
			expect(rows).toHaveLength(2)
		})

		it("finds all members of a family via the secondary index", async () => {
			using db = openMemory()
			await createAllTables(db)
			await insertCrosswalkNodes(db)

			await db.insertInto("filer_family").values(FAMILY_ROW).execute()

			await db
				.insertInto("filer_family")
				.values({ ...FAMILY_ROW, node_id: SPIN_NODE_ID, relationship: FilerRelationship.Subsidiary })
				.execute()

			const rows = await db.selectFrom("filer_family").selectAll().where("family_id", "=", FAMILY_ID).execute()
			expect(rows).toHaveLength(2)
		})

		describe("relationship", () => {
			it("rejects an empty string", async () => {
				using db = openMemory()
				await createAllTables(db)
				await insertCrosswalkNodes(db)

				await expect(
					db
						.insertInto("filer_family")
						.values({ ...FAMILY_ROW, relationship: "" })
						.execute()
				).rejects.toThrow(/CHECK constraint failed/)
			})

			it("rejects a whitespace-only string (not just empty)", async () => {
				using db = openMemory()
				await createAllTables(db)
				await insertCrosswalkNodes(db)

				await expect(
					db
						.insertInto("filer_family")
						.values({ ...FAMILY_ROW, relationship: "   " })
						.execute()
				).rejects.toThrow(/CHECK constraint failed/)
			})
		})
	})

	describe("filer_manifest single-row enforcement", () => {
		it("throws when the manifest table is empty", async () => {
			using db = openMemory()
			await createFilerManifestTable(db)
			await expect(readFilerManifest(db)).rejects.toThrow(/expected exactly 1/)
		})

		it("reads back the single manifest row", async () => {
			using db = openMemory()
			await createFilerManifestTable(db)

			await db
				.insertInto("filer_manifest")
				.values({
					name: "filer",
					version: "0.1.0",
					schema_version: 1,
					source: "form-499,bdc-provider-list",
					source_vintage: "2026-Q1",
					build_cmd: "mailwoman filer build",
					build_sha: "deadbeef",
					created_at: "2026-07-31T00:00:00Z",
				})
				.execute()

			const manifest = await readFilerManifest(db)
			expect(manifest.name).toBe("filer")
			expect(manifest.source).toBe("form-499,bdc-provider-list")
		})

		it("throws when more than one manifest row exists", async () => {
			using db = openMemory()
			await createFilerManifestTable(db)

			await db
				.insertInto("filer_manifest")
				.values([
					{
						name: "filer-a",
						version: "0.1.0",
						schema_version: 1,
						source: "form-499",
						source_vintage: "2026-Q1",
						build_cmd: "mailwoman filer build",
						build_sha: "deadbeef",
						created_at: "2026-07-31T00:00:00Z",
					},
					{
						name: "filer-b",
						version: "0.1.0",
						schema_version: 1,
						source: "bdc-provider-list",
						source_vintage: "2026-Q1",
						build_cmd: "mailwoman filer build",
						build_sha: "beefdead",
						created_at: "2026-07-31T00:00:00Z",
					},
				])
				.execute()

			await expect(readFilerManifest(db)).rejects.toThrow(/expected exactly 1/)
		})
	})
})
