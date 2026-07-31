/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode clusterAuthoritativeComponents}/{@linkcode clusterInferredLinks}/
 *   {@linkcode clusterFilers} (3a Task 6, decisions 4, 5) — built directly against an in-memory
 *   `filer.db` (nodes/edges/attributes inserted straight through Kysely, matching `schema.test.ts`'s
 *   convention), never through `buildFilerDatabase` — this suite exercises the clustering pass in
 *   isolation.
 *
 *   The GATE-2 fixture (decision 5, BINDING): two authoritative components —
 *   `frn:1111111111 <-> form499_id:100` ("Acme Telecom Inc") and `frn:2222222222 <-> form499_id:200`
 *   ("Acme Telecom LLC") — whose `legal_name` attributes canonicalize to the SAME organization key
 *   (`"acme telecom"`, once the `Inc`/`LLC` designations strip), so the inferred pass finds a link
 *   that WOULD bridge them. A third component (`frn:3333333333 <-> form499_id:300`, "Totally
 *   Different Co") is the control: unrelated by name, must never be pulled in. A fourth
 *   (`frn:4444444444 <-> form499_id:400`, no `legal_name` attribute at all) proves a nameless node is
 *   silently excluded from the inferred pass, not a crash. A fifth node
 *   (`holding_company_name:Solo Holdings`) carries no edge at all — an authoritative singleton.
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { describe, expect, it } from "vitest"

import {
	createFilerAttributeTable,
	createFilerClusterTable,
	createFilerEdgeTable,
	createFilerNodeTable,
	FilerEdgeAssertion,
	FilerIdentifierType,
	type FilerClusterTable,
	type FilerDatabase,
	type FilerEdgeTable,
	type FilerNodeTable,
} from "../schema.ts"
import {
	clusterAuthoritativeComponents,
	clusterFilers,
	clusterInferredLinks,
	CLUSTER_FILERS_SOURCE,
} from "./cluster-filers.ts"

function openMemory(): DatabaseClient<FilerDatabase> {
	return new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(":memory:") })
}

async function createAllTables(db: DatabaseClient<FilerDatabase>): Promise<void> {
	await createFilerNodeTable(db)
	await createFilerEdgeTable(db)
	await createFilerAttributeTable(db)
	await createFilerClusterTable(db)
}

const FRN_A = `${FilerIdentifierType.FRN}:1111111111`
const FORM499_A = `${FilerIdentifierType.Form499ID}:100`
const FRN_B = `${FilerIdentifierType.FRN}:2222222222`
const FORM499_B = `${FilerIdentifierType.Form499ID}:200`
const FRN_C = `${FilerIdentifierType.FRN}:3333333333`
const FORM499_C = `${FilerIdentifierType.Form499ID}:300`
const FRN_D = `${FilerIdentifierType.FRN}:4444444444`
const FORM499_D = `${FilerIdentifierType.Form499ID}:400`
const SOLO_HOLDING = `${FilerIdentifierType.HoldingCompanyName}:Solo Holdings`

const ALL_NODES: FilerNodeTable[] = [
	{ node_id: FRN_A, identifier_type: FilerIdentifierType.FRN, identifier_value: "1111111111" },
	{ node_id: FORM499_A, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "100" },
	{ node_id: FRN_B, identifier_type: FilerIdentifierType.FRN, identifier_value: "2222222222" },
	{ node_id: FORM499_B, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "200" },
	{ node_id: FRN_C, identifier_type: FilerIdentifierType.FRN, identifier_value: "3333333333" },
	{ node_id: FORM499_C, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "300" },
	{ node_id: FRN_D, identifier_type: FilerIdentifierType.FRN, identifier_value: "4444444444" },
	{ node_id: FORM499_D, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "400" },
	{ node_id: SOLO_HOLDING, identifier_type: FilerIdentifierType.HoldingCompanyName, identifier_value: "Solo Holdings" },
]

function authoritativeEdge(from: string, to: string): FilerEdgeTable {
	return {
		from_node_id: from,
		to_node_id: to,
		assertion: FilerEdgeAssertion.Authoritative,
		source: "form-499",
		source_vintage: "2026-Q1",
		valid_from: "2026-01-01",
		valid_to: null,
		match_score: null,
		evidence: null,
	}
}

const ALL_EDGES: FilerEdgeTable[] = [
	authoritativeEdge(FRN_A, FORM499_A),
	authoritativeEdge(FRN_B, FORM499_B),
	authoritativeEdge(FRN_C, FORM499_C),
	authoritativeEdge(FRN_D, FORM499_D),
]

async function seedFixture(db: DatabaseClient<FilerDatabase>): Promise<void> {
	await createAllTables(db)
	await db.insertInto("filer_node").values(ALL_NODES).execute()
	await db.insertInto("filer_edge").values(ALL_EDGES).execute()

	await db
		.insertInto("filer_attribute")
		.values([
			{
				node_id: FORM499_A,
				key: "legal_name",
				value: "Acme Telecom Inc",
				source: "form-499",
				source_vintage: "2026-Q1",
			},
			{
				node_id: FORM499_B,
				key: "legal_name",
				value: "Acme Telecom LLC",
				source: "form-499",
				source_vintage: "2026-Q1",
			},
			{
				node_id: FORM499_C,
				key: "legal_name",
				value: "Totally Different Co",
				source: "form-499",
				source_vintage: "2026-Q1",
			},
			// FORM499_D deliberately gets no legal_name attribute at all.
		])
		.execute()
}

async function readClusterMap(db: DatabaseClient<FilerDatabase>, assertion: string): Promise<Map<string, string>> {
	const rows = await db.selectFrom("filer_cluster").selectAll().where("assertion", "=", assertion).execute()

	return new Map(rows.map((row) => [row.node_id, row.cluster_id]))
}

describe("clusterAuthoritativeComponents (3a Task 6, pass a)", () => {
	it("writes one filer_cluster row per node, grouping connected components and leaving unlinked nodes as singletons", async () => {
		using db = openMemory()
		await seedFixture(db)

		const result = await clusterAuthoritativeComponents(db)

		expect(result.nodes).toBe(ALL_NODES.length)
		// 4 authoritative pairs + 1 unlinked singleton (Solo Holdings) = 5 components.
		expect(result.clusters).toBe(5)

		const rows = await db
			.selectFrom("filer_cluster")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Authoritative)
			.execute()

		expect(rows).toHaveLength(ALL_NODES.length)

		const byNode = await readClusterMap(db, FilerEdgeAssertion.Authoritative)
		expect(byNode.get(FRN_A)).toBe(byNode.get(FORM499_A))
		expect(byNode.get(FRN_B)).toBe(byNode.get(FORM499_B))
		expect(byNode.get(FRN_C)).toBe(byNode.get(FORM499_C))
		expect(byNode.get(FRN_D)).toBe(byNode.get(FORM499_D))

		// Every component distinct from every other.
		const componentIds = new Set([
			byNode.get(FRN_A),
			byNode.get(FRN_B),
			byNode.get(FRN_C),
			byNode.get(FRN_D),
			byNode.get(SOLO_HOLDING),
		])

		expect(componentIds.size).toBe(5)
	})

	it("is idempotent — running twice does not grow filer_cluster rows nor change assignments", async () => {
		using db = openMemory()
		await seedFixture(db)

		await clusterAuthoritativeComponents(db)
		const firstRun = await db.selectFrom("filer_cluster").selectAll().execute()

		await clusterAuthoritativeComponents(db)
		const secondRun = await db.selectFrom("filer_cluster").selectAll().execute()

		expect(secondRun).toHaveLength(firstRun.length)

		expect(new Map(secondRun.map((r) => [r.node_id, r.cluster_id]))).toEqual(
			new Map(firstRun.map((r) => [r.node_id, r.cluster_id]))
		)
	})
})

describe("clusterInferredLinks — gate 2 (3a Task 6, decision 5, BINDING)", () => {
	it("finds an inferred link bridging two authoritative components WITHOUT altering their authoritative cluster assignments", async () => {
		using db = openMemory()
		await seedFixture(db)

		await clusterAuthoritativeComponents(db)
		const authoritativeBefore = await readClusterMap(db, FilerEdgeAssertion.Authoritative)

		// Sanity: the two components gate 2 bridges start out distinct.
		expect(authoritativeBefore.get(FRN_A)).toBe(authoritativeBefore.get(FORM499_A))
		expect(authoritativeBefore.get(FRN_B)).toBe(authoritativeBefore.get(FORM499_B))
		expect(authoritativeBefore.get(FRN_A)).not.toBe(authoritativeBefore.get(FRN_B))

		const inferredResult = await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1" })

		// A nameless node (FORM499_D) is excluded from the candidate universe entirely.
		expect(inferredResult.recordsConsidered).toBe(3)
		expect(inferredResult.linkedClusters).toBeGreaterThanOrEqual(1)
		expect(inferredResult.links).toBeGreaterThanOrEqual(1)

		// The inferred filer_edge row is recorded, distinguishably (assertion + source + a real score/evidence).
		const inferredEdges = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		const bridge = inferredEdges.find(
			(edge) =>
				(edge.from_node_id === FORM499_A && edge.to_node_id === FORM499_B) ||
				(edge.from_node_id === FORM499_B && edge.to_node_id === FORM499_A)
		)

		expect(bridge).toBeDefined()
		expect(bridge?.source).toBe(CLUSTER_FILERS_SOURCE)
		expect(bridge?.source_vintage).toBe("2026-cluster-v1")
		expect(bridge?.valid_from).toBe("2026-cluster-v1")
		expect(bridge?.match_score).not.toBeNull()
		expect(typeof bridge?.match_score).toBe("number")
		expect(bridge?.evidence).not.toBeNull()
		expect(JSON.parse(bridge!.evidence!)).toMatchObject({ memberNodeIds: [FORM499_A, FORM499_B].toSorted() })

		// The inferred CLUSTER groups the two bridged nodes together...
		const inferredMap = await readClusterMap(db, FilerEdgeAssertion.Inferred)
		expect(inferredMap.get(FORM499_A)).toBe(inferredMap.get(FORM499_B))
		// ...and the unrelated control (different name) is never pulled in.
		expect(inferredMap.get(FORM499_C)).toBeDefined()
		expect(inferredMap.get(FORM499_C)).not.toBe(inferredMap.get(FORM499_A))
		// The nameless node never gets an inferred assignment at all.
		expect(inferredMap.has(FORM499_D)).toBe(false)

		// GATE 2 itself: the authoritative assignments are BYTE-IDENTICAL to before the inferred pass ran.
		const authoritativeAfter = await readClusterMap(db, FilerEdgeAssertion.Authoritative)
		expect(authoritativeAfter).toEqual(authoritativeBefore)
		expect(authoritativeAfter.get(FRN_A)).toBe(authoritativeAfter.get(FORM499_A))
		expect(authoritativeAfter.get(FRN_B)).toBe(authoritativeAfter.get(FORM499_B))
		expect(authoritativeAfter.get(FRN_A)).not.toBe(authoritativeAfter.get(FRN_B))
	})

	it("never writes an inferred assignment for a node with no legal_name attribute", async () => {
		using db = openMemory()
		await seedFixture(db)

		await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1" })

		const row = await db
			.selectFrom("filer_cluster")
			.selectAll()
			.where("node_id", "=", FORM499_D)
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.executeTakeFirst()

		expect(row).toBeUndefined()
	})

	it("is idempotent — running twice does not grow filer_cluster or filer_edge rows", async () => {
		using db = openMemory()
		await seedFixture(db)
		await clusterAuthoritativeComponents(db)

		await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1" })

		const clusterRowsFirst = await db
			.selectFrom("filer_cluster")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		const edgeRowsFirst = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1" })

		const clusterRowsSecond = await db
			.selectFrom("filer_cluster")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		const edgeRowsSecond = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		expect(clusterRowsSecond).toHaveLength(clusterRowsFirst.length)
		expect(edgeRowsSecond).toHaveLength(edgeRowsFirst.length)

		expect(new Map(clusterRowsSecond.map((r) => [r.node_id, r.cluster_id]))).toEqual(
			new Map(clusterRowsFirst.map((r) => [r.node_id, r.cluster_id]))
		)
	})

	it("picks the LATEST source_vintage's legal_name when a node carries more than one", async () => {
		using db = openMemory()
		await createAllTables(db)

		const renamedNode = `${FilerIdentifierType.Form499ID}:900`
		const partnerFRN = `${FilerIdentifierType.FRN}:9000000009`

		await db
			.insertInto("filer_node")
			.values([
				{ node_id: renamedNode, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "900" },
				{ node_id: partnerFRN, identifier_type: FilerIdentifierType.FRN, identifier_value: "9000000009" },
			])
			.execute()

		await db.insertInto("filer_edge").values(authoritativeEdge(partnerFRN, renamedNode)).execute()

		await db
			.insertInto("filer_attribute")
			.values([
				{
					node_id: renamedNode,
					key: "legal_name",
					value: "Old Name Co",
					source: "form-499",
					source_vintage: "2025-Q1",
				},
				{
					node_id: renamedNode,
					key: "legal_name",
					value: "New Name LLC",
					source: "form-499",
					source_vintage: "2026-Q1",
				},
			])
			.execute()

		const result = await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1" })
		expect(result.recordsConsidered).toBe(1)

		// No direct read-back of the canonicalized name is exposed on the result, so corroborate indirectly: a second
		// node with legal_name "New Name" (same canonical key as "New Name LLC", NOT "Old Name Co") should bridge.
		const secondNode = `${FilerIdentifierType.Form499ID}:901`
		const secondFRN = `${FilerIdentifierType.FRN}:9010000000`

		await db
			.insertInto("filer_node")
			.values([
				{ node_id: secondNode, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "901" },
				{ node_id: secondFRN, identifier_type: FilerIdentifierType.FRN, identifier_value: "9010000000" },
			])
			.execute()

		await db.insertInto("filer_edge").values(authoritativeEdge(secondFRN, secondNode)).execute()

		await db
			.insertInto("filer_attribute")
			.values({
				node_id: secondNode,
				key: "legal_name",
				value: "New Name Inc",
				source: "form-499",
				source_vintage: "2026-Q1",
			})
			.execute()

		const rerun = await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1" })
		expect(rerun.linkedClusters).toBe(1)

		const inferredMap = await readClusterMap(db, FilerEdgeAssertion.Inferred)
		expect(inferredMap.get(renamedNode)).toBe(inferredMap.get(secondNode))
	})
})

describe("clusterFilers (3a Task 6, orchestrator)", () => {
	it("runs both passes and returns their combined results", async () => {
		using db = openMemory()
		await seedFixture(db)

		const result = await clusterFilers(db, { sourceVintage: "2026-cluster-v1" })

		expect(result.authoritative.clusters).toBe(5)
		expect(result.inferred.linkedClusters).toBeGreaterThanOrEqual(1)

		const authoritativeRows = await db
			.selectFrom("filer_cluster")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Authoritative)
			.execute()

		const inferredRows = await db
			.selectFrom("filer_cluster")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		expect(authoritativeRows.length).toBeGreaterThan(0)
		expect(inferredRows.length).toBeGreaterThan(0)
	})
})
