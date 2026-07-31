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
	createFilerManifestTable,
	createFilerNodeTable,
	FilerEdgeAssertion,
	FilerIdentifierType,
	readFilerManifest,
	type FilerDatabase,
	type FilerEdgeTable,
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
	source: "form-499",
	source_vintage: "2026-Q1",
	valid_from: "2026-01-01",
	valid_to: null,
	match_score: null,
	evidence: null,
}

describe("filer schema", () => {
	it("creates all five filer.db tables, each accepting and returning a row", async () => {
		using db = openMemory()
		await createAllTables(db)
		await insertCrosswalkNodes(db)

		const node = await db.selectFrom("filer_node").selectAll().where("node_id", "=", FRN_NODE_ID).executeTakeFirst()
		expect(node?.identifier_type).toBe(FilerIdentifierType.FRN)

		await db.insertInto("filer_edge").values(AUTHORITATIVE_EDGE).execute()
		const edge = await db.selectFrom("filer_edge").selectAll().executeTakeFirst()
		expect(edge?.source).toBe("form-499")

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

	it("finds in-edges by to_node_id via the secondary index", async () => {
		using db = openMemory()
		await createAllTables(db)
		await insertCrosswalkNodes(db)
		await db.insertInto("filer_edge").values(AUTHORITATIVE_EDGE).execute()

		const rows = await db.selectFrom("filer_edge").selectAll().where("to_node_id", "=", SPIN_NODE_ID).execute()
		expect(rows).toHaveLength(1)
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
