/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode clusterAuthoritativeComponents}/{@linkcode clusterInferredLinks}/
 *   {@linkcode clusterFilers}/{@linkcode hasSharedIdentifier} (3a decisions 4, 5) — built
 *   directly against an in-memory `filer.db` (nodes/edges/attributes inserted straight through
 *   Kysely, matching `schema.test.ts`'s convention), never through `buildFilerDatabase` — this suite
 *   exercises the clustering pass in isolation.
 *
 *   **Why the identifier veto is hard, not a score.** Pure organization-name matching (even with
 *   `exactDiscriminators` wired in) produces real false-identity links across DIFFERENT authoritative
 *   components — two DIFFERENT components structurally always have disjoint frn/form499ID/providerID
 *   code sets, so those "discriminators" can only ever contribute a constant negative tax, never
 *   separate anything. Hence {@linkcode hasSharedIdentifier}: a link can only ever form between two
 *   nodes that ALREADY share an authoritative identifier. A NAME-ONLY match bridging two different
 *   authoritative components (component A / component B, no shared identifier) must NEVER form at
 *   all, which is why the fixtures below assert its absence rather than its cluster assignment. The
 *   "positive control" fixtures (two nodes sharing an authoritative FRN) are what a GENUINE inferred
 *   link looks like, and gate 2 is tested against THAT: even a real, sanctioned inferred link must
 *   never alter an authoritative cluster assignment.
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
	FilerRelationship,
	type FilerDatabase,
	type FilerEdgeTable,
	type FilerNodeTable,
} from "../schema.ts"
import {
	clusterAuthoritativeComponents,
	clusterFilers,
	clusterInferredLinks,
	CLUSTER_FILERS_SOURCE,
	hasSharedIdentifier,
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
		relationship: FilerRelationship.SameEntity,
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

/**
 * Insert a pair of `form499_id` nodes that SHARE an authoritative FRN (a re-filing under one registrant) — the only
 * shape that lets an inferred link form at all under the identifier veto (see the module docstring).
 */
async function seedSharedFRNPair(
	db: DatabaseClient<FilerDatabase>,
	frn: string,
	nodeA: string,
	nodeB: string,
	names: { a: string; b: string },
	vintage = "2026-Q1"
): Promise<void> {
	const frnNodeID = `${FilerIdentifierType.FRN}:${frn}`
	const nodeAID = `${FilerIdentifierType.Form499ID}:${nodeA}`
	const nodeBID = `${FilerIdentifierType.Form499ID}:${nodeB}`

	await db
		.insertInto("filer_node")
		.values([
			{ node_id: frnNodeID, identifier_type: FilerIdentifierType.FRN, identifier_value: frn },
			{ node_id: nodeAID, identifier_type: FilerIdentifierType.Form499ID, identifier_value: nodeA },
			{ node_id: nodeBID, identifier_type: FilerIdentifierType.Form499ID, identifier_value: nodeB },
		])
		.execute()

	await db
		.insertInto("filer_edge")
		.values([authoritativeEdge(frnNodeID, nodeAID), authoritativeEdge(frnNodeID, nodeBID)])
		.execute()

	await db
		.insertInto("filer_attribute")
		.values([
			{ node_id: nodeAID, key: "legal_name", value: names.a, source: "form-499", source_vintage: vintage },
			{ node_id: nodeBID, key: "legal_name", value: names.b, source: "form-499", source_vintage: vintage },
		])
		.execute()
}

/**
 * Insert a pair of `form499_id` nodes under DIFFERENT, unrelated FRNs (two genuinely different authoritative
 * components) whose legal names happen to canonicalize to the same key — the false-positive shape the veto exists to
 * reject.
 */
async function seedDisjointNamedPair(
	db: DatabaseClient<FilerDatabase>,
	frnA: string,
	nodeA: string,
	nameA: string,
	frnB: string,
	nodeB: string,
	nameB: string
): Promise<void> {
	const frnAID = `${FilerIdentifierType.FRN}:${frnA}`
	const frnBID = `${FilerIdentifierType.FRN}:${frnB}`
	const nodeAID = `${FilerIdentifierType.Form499ID}:${nodeA}`
	const nodeBID = `${FilerIdentifierType.Form499ID}:${nodeB}`

	await db
		.insertInto("filer_node")
		.values([
			{ node_id: frnAID, identifier_type: FilerIdentifierType.FRN, identifier_value: frnA },
			{ node_id: nodeAID, identifier_type: FilerIdentifierType.Form499ID, identifier_value: nodeA },
			{ node_id: frnBID, identifier_type: FilerIdentifierType.FRN, identifier_value: frnB },
			{ node_id: nodeBID, identifier_type: FilerIdentifierType.Form499ID, identifier_value: nodeB },
		])
		.execute()

	await db
		.insertInto("filer_edge")
		.values([authoritativeEdge(frnAID, nodeAID), authoritativeEdge(frnBID, nodeBID)])
		.execute()

	await db
		.insertInto("filer_attribute")
		.values([
			{ node_id: nodeAID, key: "legal_name", value: nameA, source: "form-499", source_vintage: "2026-Q1" },
			{ node_id: nodeBID, key: "legal_name", value: nameB, source: "form-499", source_vintage: "2026-Q1" },
		])
		.execute()
}

describe("hasSharedIdentifier — the hard veto's core predicate", () => {
	it("is true when two records share a code on ANY of frn/form499ID/providerID", () => {
		expect(
			hasSharedIdentifier(
				{ id: "x", attributes: { frn: "1234567890", form499ID: "100" } },
				{ id: "y", attributes: { frn: "1234567890", form499ID: "200" } }
			)
		).toBe(true)

		expect(
			hasSharedIdentifier(
				{ id: "x", attributes: { providerID: "100 200" } },
				{ id: "y", attributes: { providerID: "200 300" } }
			)
		).toBe(true)
	})

	it("is false when every populated type is disjoint on both sides — the false-positive shape", () => {
		expect(
			hasSharedIdentifier(
				{ id: "x", attributes: { frn: "1111111111", form499ID: "100" } },
				{ id: "y", attributes: { frn: "2222222222", form499ID: "200" } }
			)
		).toBe(false)
	})

	it("is false (not true) when identifier data is simply MISSING on one or both sides — silence is not evidence", () => {
		expect(hasSharedIdentifier({ id: "x", attributes: {} }, { id: "y", attributes: { frn: "1111111111" } })).toBe(false)
		expect(hasSharedIdentifier({ id: "x" }, { id: "y" })).toBe(false)
	})
})

describe("clusterAuthoritativeComponents (pass a)", () => {
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

describe("clusterInferredLinks — the identifier veto", () => {
	it("does NOT bridge two authoritative components via a name-only match — and authoritative clustering stays untouched regardless", async () => {
		using db = openMemory()
		await seedFixture(db)

		await clusterAuthoritativeComponents(db)
		const authoritativeBefore = await readClusterMap(db, FilerEdgeAssertion.Authoritative)

		// Sanity: the two components share a canonical name ("Acme Telecom") but start out distinct.
		expect(authoritativeBefore.get(FRN_A)).toBe(authoritativeBefore.get(FORM499_A))
		expect(authoritativeBefore.get(FRN_B)).toBe(authoritativeBefore.get(FORM499_B))
		expect(authoritativeBefore.get(FRN_A)).not.toBe(authoritativeBefore.get(FRN_B))

		const inferredResult = await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })

		// A nameless node (FORM499_D) is excluded from the candidate universe entirely.
		expect(inferredResult.recordsConsidered).toBe(3)
		// NO link forms: Acme Telecom Inc (FRN_A) and Acme Telecom LLC (FRN_B) have disjoint frn/form499ID and no
		// providerID at all — the hard veto fires despite the exact canonical-name match.
		expect(inferredResult.linkedClusters).toBe(0)
		expect(inferredResult.links).toBe(0)

		const inferredEdges = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		expect(inferredEdges).toHaveLength(0)

		// The inferred CLUSTER keeps them apart too — each in its own singleton.
		const inferredMap = await readClusterMap(db, FilerEdgeAssertion.Inferred)
		expect(inferredMap.get(FORM499_A)).toBeDefined()
		expect(inferredMap.get(FORM499_A)).not.toBe(inferredMap.get(FORM499_B))
		expect(inferredMap.get(FORM499_A)).not.toBe(inferredMap.get(FORM499_C))
		// The nameless node never gets an inferred assignment at all.
		expect(inferredMap.has(FORM499_D)).toBe(false)

		// GATE 2: the authoritative assignments are BYTE-IDENTICAL to before the inferred pass ran (true both
		// because nothing bridged AND because the passes write disjoint assertion values by construction).
		const authoritativeAfter = await readClusterMap(db, FilerEdgeAssertion.Authoritative)
		expect(authoritativeAfter).toEqual(authoritativeBefore)
	})

	it("never links a false-positive pair, despite colliding canonical names and disjoint identifiers", async () => {
		using db = openMemory()
		await createAllTables(db)

		await seedDisjointNamedPair(
			db,
			"5551110000",
			"500",
			"American Broadband LLC",
			"6661110000",
			"600",
			"American Broadband, Inc."
		)

		await seedDisjointNamedPair(
			db,
			"7771110000",
			"700",
			"Citizens Telecom LLC",
			"8881110000",
			"800",
			"Citizens Telecom Corporation"
		)

		const result = await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })

		expect(result.recordsConsidered).toBe(4)
		expect(result.linkedClusters).toBe(0)
		expect(result.links).toBe(0)

		const inferredEdges = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		expect(inferredEdges).toHaveLength(0)

		const inferredMap = await readClusterMap(db, FilerEdgeAssertion.Inferred)
		const americanA = `${FilerIdentifierType.Form499ID}:500`
		const americanB = `${FilerIdentifierType.Form499ID}:600`
		const citizensA = `${FilerIdentifierType.Form499ID}:700`
		const citizensB = `${FilerIdentifierType.Form499ID}:800`

		expect(inferredMap.get(americanA)).not.toBe(inferredMap.get(americanB))
		expect(inferredMap.get(citizensA)).not.toBe(inferredMap.get(citizensB))
	})

	it("POSITIVE CONTROL: still links two nodes sharing an authoritative FRN despite a name variant, without touching authoritative assignments", async () => {
		using db = openMemory()
		await createAllTables(db)

		const nodeAID = `${FilerIdentifierType.Form499ID}:950`
		const nodeBID = `${FilerIdentifierType.Form499ID}:951`

		await seedSharedFRNPair(db, "9990000000", "950", "951", {
			a: "Delta Communications Inc",
			b: "Delta Communications LLC",
		})

		const authoritativeResult = await clusterAuthoritativeComponents(db)
		const authoritativeBefore = await readClusterMap(db, FilerEdgeAssertion.Authoritative)
		expect(authoritativeBefore.get(nodeAID)).toBe(authoritativeBefore.get(nodeBID))

		const inferredResult = await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })

		expect(inferredResult.linkedClusters).toBe(1)
		expect(inferredResult.links).toBeGreaterThanOrEqual(1)

		const inferredEdges = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		const bridge = inferredEdges.find(
			(edge) =>
				(edge.from_node_id === nodeAID && edge.to_node_id === nodeBID) ||
				(edge.from_node_id === nodeBID && edge.to_node_id === nodeAID)
		)

		expect(bridge).toBeDefined()
		expect(bridge?.source).toBe(CLUSTER_FILERS_SOURCE)
		expect(bridge?.match_score).not.toBeNull()

		// GATE 2, still: even a REAL, sanctioned inferred link never alters the authoritative assignment.
		const authoritativeAfter = await readClusterMap(db, FilerEdgeAssertion.Authoritative)
		expect(authoritativeAfter).toEqual(authoritativeBefore)
		expect(authoritativeResult.clusters).toBe(1)
	})

	it("source_vintage stays the human vintage LABEL while valid_from is the SEPARATE ISO date — the label never reaches valid_from", async () => {
		using db = openMemory()
		await createAllTables(db)

		const nodeAID = `${FilerIdentifierType.Form499ID}:960`
		const nodeBID = `${FilerIdentifierType.Form499ID}:961`

		await seedSharedFRNPair(db, "9990000001", "960", "961", {
			a: "Vintage Split Co Inc",
			b: "Vintage Split Co LLC",
		})

		await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })

		const inferredEdges = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.where((eb) => eb.or([eb("from_node_id", "=", nodeAID), eb("from_node_id", "=", nodeBID)]))
			.execute()

		expect(inferredEdges).toHaveLength(1)
		expect(inferredEdges[0]?.source_vintage).toBe("2026-cluster-v1")
		expect(inferredEdges[0]?.valid_from).toBe("2026-07-01")
		expect(inferredEdges[0]?.valid_from).not.toBe("2026-cluster-v1")
		expect(inferredEdges[0]?.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	})

	it("throws when validFrom is not an ISO date — a vintage label must never reach valid_from", async () => {
		using db = openMemory()
		await createAllTables(db)

		await expect(
			clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-cluster-v1" })
		).rejects.toThrow(/not an ISO YYYY-MM-DD date/)
	})

	it("never writes an inferred assignment for a node with no legal_name attribute", async () => {
		using db = openMemory()
		await seedFixture(db)

		await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })

		const row = await db
			.selectFrom("filer_cluster")
			.selectAll()
			.where("node_id", "=", FORM499_D)
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.executeTakeFirst()

		expect(row).toBeUndefined()
	})

	it("excludes a form499_id node whose legal_name reduces to an EMPTY canonical string (round-2 fix, minor)", async () => {
		using db = openMemory()
		await createAllTables(db)

		// "LLC" alone is entirely a stripped legal designation — canonicalizeOrganizationName returns a TRUTHY
		// object ({ raw: "LLC", canonical: "", designations: ["llc"] }), which a bare `!organization` check
		// would have missed.
		const designationOnlyFRN = `${FilerIdentifierType.FRN}:1230000000`
		const designationOnlyNode = `${FilerIdentifierType.Form499ID}:999999`

		await db
			.insertInto("filer_node")
			.values([
				{ node_id: designationOnlyFRN, identifier_type: FilerIdentifierType.FRN, identifier_value: "1230000000" },
				{
					node_id: designationOnlyNode,
					identifier_type: FilerIdentifierType.Form499ID,
					identifier_value: "999999",
				},
			])
			.execute()

		await db.insertInto("filer_edge").values(authoritativeEdge(designationOnlyFRN, designationOnlyNode)).execute()

		await db
			.insertInto("filer_attribute")
			.values({
				node_id: designationOnlyNode,
				key: "legal_name",
				value: "LLC",
				source: "form-499",
				source_vintage: "2026-Q1",
			})
			.execute()

		// A normal node, present purely so `recordsConsidered` has something to be COMPARED against (proving
		// the designation-only node was excluded, not that nothing was scored at all).
		const normalFRN = `${FilerIdentifierType.FRN}:1230000001`
		const normalNode = `${FilerIdentifierType.Form499ID}:999998`

		await db
			.insertInto("filer_node")
			.values([
				{ node_id: normalFRN, identifier_type: FilerIdentifierType.FRN, identifier_value: "1230000001" },
				{ node_id: normalNode, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "999998" },
			])
			.execute()

		await db.insertInto("filer_edge").values(authoritativeEdge(normalFRN, normalNode)).execute()

		await db
			.insertInto("filer_attribute")
			.values({
				node_id: normalNode,
				key: "legal_name",
				value: "Ordinary Networks Inc",
				source: "form-499",
				source_vintage: "2026-Q1",
			})
			.execute()

		const result = await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })
		expect(result.recordsConsidered).toBe(1)

		const inferredMap = await readClusterMap(db, FilerEdgeAssertion.Inferred)
		expect(inferredMap.has(designationOnlyNode)).toBe(false)
		expect(inferredMap.has(normalNode)).toBe(true)
	})

	it("is idempotent — running twice AT THE SAME VINTAGE does not grow filer_cluster or filer_edge rows", async () => {
		using db = openMemory()
		await seedFixture(db)
		await clusterAuthoritativeComponents(db)

		await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })

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

		await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })

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

	it("picks the LATEST source_vintage's legal_name when a node carries more than one (using a shared-FRN pair so the veto doesn't mask the effect)", async () => {
		using db = openMemory()
		await createAllTables(db)

		const frnNodeID = `${FilerIdentifierType.FRN}:9000000009`
		const renamedNode = `${FilerIdentifierType.Form499ID}:900`
		const secondNode = `${FilerIdentifierType.Form499ID}:901`

		await db
			.insertInto("filer_node")
			.values([
				{ node_id: frnNodeID, identifier_type: FilerIdentifierType.FRN, identifier_value: "9000000009" },
				{ node_id: renamedNode, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "900" },
				{ node_id: secondNode, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "901" },
			])
			.execute()

		// Both under the SAME frn (a shared authoritative component) — the only shape a link can form under
		// the identifier veto, so this test isolates "which vintage's name gets used" from "does the veto fire".
		await db
			.insertInto("filer_edge")
			.values([authoritativeEdge(frnNodeID, renamedNode), authoritativeEdge(frnNodeID, secondNode)])
			.execute()

		await db
			.insertInto("filer_attribute")
			.values([
				{
					node_id: renamedNode,
					key: "legal_name",
					value: "Legacy Systems Co",
					source: "form-499",
					source_vintage: "2025-01-01",
				},
				{
					node_id: renamedNode,
					key: "legal_name",
					value: "New Name LLC",
					source: "form-499",
					source_vintage: "2026-01-01",
				},
				{
					node_id: secondNode,
					key: "legal_name",
					value: "New Name Inc",
					source: "form-499",
					source_vintage: "2026-01-01",
				},
			])
			.execute()

		// If the EARLIEST name ("Legacy Systems Co") were picked instead of the latest, the canonical keys
		// ("legacy systems co" vs "new name") would never co-block and no link would form.
		const result = await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })
		expect(result.recordsConsidered).toBe(2)
		expect(result.linkedClusters).toBe(1)

		const inferredMap = await readClusterMap(db, FilerEdgeAssertion.Inferred)
		expect(inferredMap.get(renamedNode)).toBe(inferredMap.get(secondNode))
	})
})

describe("clusterInferredLinks — cross-vintage supersession", () => {
	it("closes a stale inferred edge when the underlying link no longer holds at a later vintage", async () => {
		using db = openMemory()
		await createAllTables(db)

		const nodeAID = `${FilerIdentifierType.Form499ID}:700`
		const nodeBID = `${FilerIdentifierType.Form499ID}:701`

		await seedSharedFRNPair(db, "7000000007", "700", "701", { a: "Merge Co Corp", b: "Merge Co Inc" }, "2026-01-01")

		// v1: the names collide (canonical "merge co" both sides) — a link forms.
		const v1 = await clusterInferredLinks(db, { sourceVintage: "2026-01-01", validFrom: "2026-01-01" })
		expect(v1.linkedClusters).toBe(1)

		const edgesAfterV1 = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		expect(edgesAfterV1).toHaveLength(1)
		expect(edgesAfterV1[0]?.valid_from).toBe("2026-01-01")
		expect(edgesAfterV1[0]?.valid_to).toBeNull()

		// Between v1 and v2, node B's legal name diverges (a later, unrelated filing) — the names no longer
		// co-block, so v2's clustering should NOT find a link anymore.
		await db
			.insertInto("filer_attribute")
			.values({
				node_id: nodeBID,
				key: "legal_name",
				value: "Totally Unrelated Name",
				source: "form-499",
				source_vintage: "2026-02-01",
			})
			.execute()

		const v2 = await clusterInferredLinks(db, { sourceVintage: "2026-02-01", validFrom: "2026-02-01" })
		expect(v2.linkedClusters).toBe(0)

		// filer_cluster correctly reflects the split.
		const inferredMap = await readClusterMap(db, FilerEdgeAssertion.Inferred)
		expect(inferredMap.get(nodeAID)).not.toBe(inferredMap.get(nodeBID))

		// filer_edge must NOT contradict that: the v1 row is now CLOSED (valid_to = the v2 vintage), and no new
		// open (still "valid") inferred edge connects them.
		const edgesAfterV2 = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		expect(edgesAfterV2).toHaveLength(1)
		expect(edgesAfterV2[0]?.valid_from).toBe("2026-01-01")
		expect(edgesAfterV2[0]?.valid_to).toBe("2026-02-01")

		const stillOpen = edgesAfterV2.filter((edge) => edge.valid_to === null)
		expect(stillOpen).toHaveLength(0)
	})

	it("does NOT close a same-vintage rerun's own edges (idempotency is unaffected by the supersession fix)", async () => {
		using db = openMemory()
		await createAllTables(db)

		await seedSharedFRNPair(db, "6000000006", "600", "601", { a: "Rerun Co Corp", b: "Rerun Co Inc" }, "2026-Q1")

		await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })

		const firstRun = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		expect(firstRun).toHaveLength(1)
		expect(firstRun[0]?.valid_to).toBeNull()

		await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })

		const secondRun = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		expect(secondRun).toHaveLength(1)
		expect(secondRun[0]?.valid_to).toBeNull()
		// valid_from is the SEPARATE, always-ISO `validFrom` option — never the (non-ISO) sourceVintage label.
		expect(secondRun[0]?.valid_from).toBe("2026-07-01")
	})

	it("supersedes its own prior inferred edges on a SAME-vintage REBUILD after corrected input", async () => {
		using db = openMemory()
		await createAllTables(db)

		const nodeAID = `${FilerIdentifierType.Form499ID}:750`
		const nodeBID = `${FilerIdentifierType.Form499ID}:751`

		await seedSharedFRNPair(db, "7500000007", "750", "751", { a: "Rebuild Co Corp", b: "Rebuild Co Inc" }, "2026-Q1")

		// First build at v1: names collide, a link forms.
		const firstBuild = await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })
		expect(firstBuild.linkedClusters).toBe(1)

		const edgesAfterFirstBuild = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		expect(edgesAfterFirstBuild).toHaveLength(1)
		expect(edgesAfterFirstBuild[0]?.valid_to).toBeNull()

		// filer.db gets corrected and rebuilt (node B's real legal name was wrong) WITHOUT bumping the
		// clustering vintage label — a plausible operational correction re-run, not a new reporting period.
		await db
			.insertInto("filer_attribute")
			.values({
				node_id: nodeBID,
				key: "legal_name",
				value: "Totally Unrelated Name",
				source: "form-499",
				source_vintage: "2026-Q2",
			})
			.execute()

		// Rebuild at the SAME sourceVintage as before.
		const rebuild = await clusterInferredLinks(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })
		expect(rebuild.linkedClusters).toBe(0)

		// filer_cluster correctly reflects the split...
		const inferredMap = await readClusterMap(db, FilerEdgeAssertion.Inferred)
		expect(inferredMap.get(nodeAID)).not.toBe(inferredMap.get(nodeBID))

		// ...and filer_edge must NOT contradict that: zero rows at all connecting them (the stale same-vintage
		// row was DELETED, not left open — see the module docstring's "cross-vintage supersession" section),
		// and specifically zero OPEN (still "valid") inferred edges anywhere.
		const edgesAfterRebuild = await db
			.selectFrom("filer_edge")
			.selectAll()
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.execute()

		expect(edgesAfterRebuild).toHaveLength(0)

		const stillOpen = edgesAfterRebuild.filter((edge) => edge.valid_to === null)
		expect(stillOpen).toHaveLength(0)
	})
})

describe("clusterFilers (orchestrator)", () => {
	it("runs both passes and returns their combined results, including a real inferred link", async () => {
		using db = openMemory()
		await seedFixture(db)
		// Layer a shared-FRN positive-control pair on top of the base fixture so the inferred pass has a
		// genuine, veto-passing link to find.
		await seedSharedFRNPair(db, "9990009990", "990", "991", { a: "Orchestrator Co Corp", b: "Orchestrator Co Inc" })

		const result = await clusterFilers(db, { sourceVintage: "2026-cluster-v1", validFrom: "2026-07-01" })

		expect(result.authoritative.clusters).toBe(6)
		expect(result.inferred.linkedClusters).toBe(1)

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
