/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds authoritative and inferred filer clusters in `filer.db`.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { cluster, exactKey, scorePair, type ScoredLink } from "@mailwoman/match"
import { canonicalizeOrganizationName } from "@mailwoman/record"
import { buildDefaultModel, resolveEntities, type SourceRecord } from "@mailwoman/registry"
import type { Kysely } from "kysely"

import {
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	type FilerClusterTable,
	type FilerDatabase,
} from "#schema"
import { assertISODate } from "#sdk/guards"

/**
 * The `source` value on inferred edges that this module writes.
 */
export const CLUSTER_FILERS_SOURCE = "cluster-filers"

const LEGAL_NAME_ATTRIBUTE_KEY = "legal_name"

/**
 * Fellegi-Sunter weight cutoff for inferred links.
 *
 * The value depends on the model weights and needs review if they change.
 */
export const INFERRED_LINK_THRESHOLD = -13

/**
 * Identifier attributes.
 * A candidate pair must share at least one of them.
 */
const IDENTIFIER_VETO_KEYS = ["frn", "form499ID", "providerID"] as const

/**
 * Returns whether two records share any FRN, Form 499 ID or provider ID.
 *
 * A missing value on either side counts as unknown and never as a mismatch.
 */
export function hasSharedIdentifier(a: SourceRecord, b: SourceRecord): boolean {
	for (const key of IDENTIFIER_VETO_KEYS) {
		const valueA = a.attributes?.[key]
		const valueB = b.attributes?.[key]

		if (!valueA || !valueB) continue

		const codesA = new Set(valueA.split(" "))

		for (const code of valueB.split(" ")) {
			if (code && codesA.has(code)) return true
		}
	}

	return false
}

const INFERRED_SCORING_MODEL = buildDefaultModel({
	collapseSpatial: true,
	exactDiscriminators: [...IDENTIFIER_VETO_KEYS],
})

/**
 * Scores a pair with the Fellegi-Sunter model.
 *
 * A pair without a shared identifier scores negative infinity.
 */
function scoreWithIdentifierVeto(a: SourceRecord, b: SourceRecord): number {
	if (!hasSharedIdentifier(a, b)) return Number.NEGATIVE_INFINITY

	return scorePair(INFERRED_SCORING_MODEL, a, b).weight
}

/**
 * Rows per `filer_cluster` insert.
 *
 * The size keeps each statement under SQLite's parameter limit.
 */
const CLUSTER_INSERT_BATCH_SIZE = 500

/**
 * Counts returned by {@linkcode clusterAuthoritativeComponents}.
 */
export interface AuthoritativeClusterResult {
	/**
	 * Count of connected components, including singletons.
	 */
	clusters: number
	/**
	 * Count of nodes assigned to a cluster.
	 */
	nodes: number
}

/**
 * Counts returned by {@linkcode clusterInferredLinks}.
 */
export interface InferredClusterResult {
	/**
	 * Count of Form 499 nodes whose legal name has a non-empty canonical form.
	 */
	recordsConsidered: number
	/**
	 * Count of entities with more than one record.
	 */
	linkedClusters: number
	/**
	 * Count of inferred edges written.
	 * Each member other than the representative gets one edge.
	 */
	links: number
}

/**
 * Options for {@linkcode clusterInferredLinks} and {@linkcode clusterFilers}.
 */
export interface ClusterFilersOptions {
	/**
	 * Run label written to `source_vintage`.
	 *
	 * A rerun with the same label replaces that run's inferred edges.
	 */
	sourceVintage: string
	/**
	 * ISO effective date written to `valid_from`.
	 */
	validFrom: string
	onProgress?: (message: string) => void
}

/**
 * Result of {@linkcode clusterFilers}.
 */
export interface ClusterFilersResult {
	authoritative: AuthoritativeClusterResult
	inferred: InferredClusterResult
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = []

	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size))
	}

	return chunks
}

/**
 * Joins the distinct codes in sorted order.
 * The result is empty when there are no codes.
 */
function codeSetString(values: Iterable<string>): string {
	return [...new Set(values)].toSorted().join(" ")
}

async function readNodeInfo(
	db: Kysely<FilerDatabase>
): Promise<Map<string, { identifierType: string; identifierValue: string }>> {
	const rows = await db
		.selectFrom("filer_node")
		.select(["node_id", "identifier_type", "identifier_value"])
		.orderBy("node_id")
		.execute()

	return new Map(
		rows.map((row) => [row.node_id, { identifierType: row.identifier_type, identifierValue: row.identifier_value }])
	)
}

/**
 * Groups nodes into connected components over authoritative `same_entity` edges.
 */
async function readAuthoritativeGroups(db: Kysely<FilerDatabase>): Promise<string[][]> {
	const nodeRows = await db.selectFrom("filer_node").select(["node_id"]).orderBy("node_id").execute()
	const nodeIDs = nodeRows.map((row) => row.node_id)

	const edgeRows = await db
		.selectFrom("filer_edge")
		.select(["from_node_id", "to_node_id"])
		.where("assertion", "=", FilerEdgeAssertion.Authoritative)
		.where("relationship", "=", FilerRelationship.SameEntity)
		.execute()

	const links: ScoredLink<string>[] = edgeRows.map((row) => ({
		a: row.from_node_id,
		b: row.to_node_id,
		weight: Number.POSITIVE_INFINITY,
	}))

	// Every edge has infinite weight, so the threshold admits all of them.
	return cluster(nodeIDs, links, { threshold: 0 })
}

/**
 * Replaces the authoritative `filer_cluster` rows in one transaction.
 */
export async function clusterAuthoritativeComponents(db: Kysely<FilerDatabase>): Promise<AuthoritativeClusterResult> {
	const groups = await readAuthoritativeGroups(db)

	const rows: FilerClusterTable[] = groups.flatMap((group) => {
		// The cluster ID comes from the smallest member ID, so reruns produce the same ID.
		const clusterID = `${FilerEdgeAssertion.Authoritative}:${[...group].toSorted()[0]}`

		return group.map((nodeID) => ({
			node_id: nodeID,
			cluster_id: clusterID,
			assertion: FilerEdgeAssertion.Authoritative,
		}))
	})

	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("filer_cluster").where("assertion", "=", FilerEdgeAssertion.Authoritative).execute()

		for (const batch of chunk(rows, CLUSTER_INSERT_BATCH_SIZE)) {
			if (batch.length) {
				await trx.insertInto("filer_cluster").values(batch).execute()
			}
		}
	})

	return { clusters: groups.length, nodes: rows.length }
}

/**
 * Reads each node's legal name from its latest source vintage.
 */
async function readLatestLegalNames(db: Kysely<FilerDatabase>): Promise<Map<string, string>> {
	const rows = await db
		.selectFrom("filer_attribute")
		.select(["node_id", "value", "source_vintage"])
		.where("key", "=", LEGAL_NAME_ATTRIBUTE_KEY)
		.execute()

	const latest = new Map<string, { value: string; vintage: string }>()

	for (const row of rows) {
		const current = latest.get(row.node_id)

		if (!current || row.source_vintage > current.vintage) {
			latest.set(row.node_id, { value: row.value, vintage: row.source_vintage })
		}
	}

	return new Map([...latest].map(([nodeID, { value }]) => [nodeID, value]))
}

/**
 * Builds a candidate record for each Form 499 node whose legal name has a non-empty canonical form.
 *
 * Each record carries the identifiers of its whole authoritative cluster.
 */
async function buildInferredRecords(db: Kysely<FilerDatabase>): Promise<SourceRecord[]> {
	const nodeInfo = await readNodeInfo(db)
	const groups = await readAuthoritativeGroups(db)
	const legalNames = await readLatestLegalNames(db)

	const groupOfNode = new Map<string, string[]>()

	for (const group of groups) {
		for (const nodeID of group) {
			groupOfNode.set(nodeID, group)
		}
	}

	const codesByType = (group: string[], identifierType: string): string =>
		codeSetString(
			group
				.filter((nodeID) => nodeInfo.get(nodeID)?.identifierType === identifierType)
				.map((nodeID) => nodeInfo.get(nodeID)!.identifierValue)
		)

	const records: SourceRecord[] = []

	for (const [nodeID, info] of nodeInfo) {
		if (info.identifierType !== FilerIdentifierType.Form499ID) continue

		const legalName = legalNames.get(nodeID)

		if (!legalName) continue

		const organization = canonicalizeOrganizationName(legalName)

		// An empty canonical name cannot serve as a blocking key.
		if (!organization || !organization.canonical) continue

		const group = groupOfNode.get(nodeID) ?? [nodeID]

		const attributes: Record<string, string> = {}
		const frnCodes = codesByType(group, FilerIdentifierType.FRN)
		const form499Codes = codesByType(group, FilerIdentifierType.Form499ID)
		const providerCodes = codesByType(group, FilerIdentifierType.BDCProviderID)

		// Absent codes are left out so the scorer treats them as missing evidence.
		if (frnCodes) {
			attributes.frn = frnCodes
		}

		if (form499Codes) {
			attributes.form499ID = form499Codes
		}

		if (providerCodes) {
			attributes.providerID = providerCodes
		}

		records.push({ id: nodeID, organization, attributes })
	}

	return records
}

/**
 * Links Form 499 nodes that share a canonical legal name and an identifier,
 * then rewrites the inferred clusters and edges.
 *
 * The pass deletes this vintage's earlier inferred edges and closes open edges from earlier effective dates.
 */
export async function clusterInferredLinks(
	db: Kysely<FilerDatabase>,
	options: ClusterFilersOptions
): Promise<InferredClusterResult> {
	const progress = options.onProgress ?? (() => {})

	const validFrom = assertISODate(options.validFrom, "options.validFrom", "clusterInferredLinks")

	const records = await buildInferredRecords(db)

	progress(`pass (b): scoring ${records.length.toLocaleString()} form499_id record(s) with a legal name`)

	const { entities } = resolveEntities(records, {
		// Filer records have no geographic or contact fields, so blocking uses the canonical name.
		blockingKeys: [exactKey((record: SourceRecord) => record.organization?.canonical)],
		exactDiscriminators: [...IDENTIFIER_VETO_KEYS],
		// The bundled learned scorer was trained on NPPES data.
		learnedScorer: false,
		scorer: scoreWithIdentifierVeto,
		threshold: INFERRED_LINK_THRESHOLD,
	})

	const clusterRows: FilerClusterTable[] = []
	let linkedClusters = 0
	let links = 0

	await db.transaction().execute(async (trx) => {
		await trx
			.deleteFrom("filer_edge")
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.where("source", "=", CLUSTER_FILERS_SOURCE)
			.where("source_vintage", "=", options.sourceVintage)
			.execute()

		await trx
			.updateTable("filer_edge")
			.set({ valid_to: validFrom })
			.where("assertion", "=", FilerEdgeAssertion.Inferred)
			.where("source", "=", CLUSTER_FILERS_SOURCE)
			.where("valid_to", "is", null)
			.where("valid_from", "<", validFrom)
			.execute()

		await trx.deleteFrom("filer_cluster").where("assertion", "=", FilerEdgeAssertion.Inferred).execute()

		for (const entity of entities) {
			const memberNodeIDs = entity.records.map((record) => record.id).toSorted()
			const clusterID = `${FilerEdgeAssertion.Inferred}:${memberNodeIDs[0]}`

			for (const nodeID of memberNodeIDs) {
				clusterRows.push({ node_id: nodeID, cluster_id: clusterID, assertion: FilerEdgeAssertion.Inferred })
			}

			if (entity.records.length <= 1) continue

			linkedClusters++
			const representativeID = entity.representative.id

			for (const nodeID of memberNodeIDs) {
				if (nodeID === representativeID) continue

				await trx
					.insertInto("filer_edge")
					.values({
						from_node_id: nodeID,
						to_node_id: representativeID,
						assertion: FilerEdgeAssertion.Inferred,
						relationship: FilerRelationship.SameEntity,
						source: CLUSTER_FILERS_SOURCE,
						source_vintage: options.sourceVintage,
						valid_from: validFrom,
						valid_to: null,
						match_score: entity.cohesion,
						evidence: stringifyJSON({ memberNodeIDs }),
					})
					// The deletes above should prevent conflicts. The clause is a safeguard.
					.onConflict((oc) => oc.doNothing())
					.execute()

				links++
			}
		}

		for (const batch of chunk(clusterRows, CLUSTER_INSERT_BATCH_SIZE)) {
			if (batch.length) {
				await trx.insertInto("filer_cluster").values(batch).execute()
			}
		}
	})

	progress(
		`pass (b): ${linkedClusters.toLocaleString()} inferred link(s) found, ${links.toLocaleString()} filer_edge row(s) written`
	)

	return { recordsConsidered: records.length, linkedClusters, links }
}

/**
 * Runs the authoritative pass and then the inferred pass.
 */
export async function clusterFilers(
	db: Kysely<FilerDatabase>,
	options: ClusterFilersOptions
): Promise<ClusterFilersResult> {
	const authoritative = await clusterAuthoritativeComponents(db)
	const inferred = await clusterInferredLinks(db, options)

	return { authoritative, inferred }
}
