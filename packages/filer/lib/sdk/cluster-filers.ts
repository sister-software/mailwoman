/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build authoritative and inferred clusters from `filer.db`. Authoritative clusters use only `same_entity` edges;
 *   inferred links require an exact canonical-name block and a shared FRN, Form 499 ID, or provider ID.
 *
 *   Each pass transactionally replaces its cluster assignments. Inferred edges refresh for the current vintage and
 *   close earlier open edges. `sourceVintage` identifies the run; ISO `validFrom` records its effective date.
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
 * Source value for inferred edges written by this module.
 */
export const CLUSTER_FILERS_SOURCE = "cluster-filers"

/**
 * Attribute key used to name-match Form 499 nodes.
 */
const LEGAL_NAME_ATTRIBUTE_KEY = "legal_name"

/**
 * Fellegi-Sunter cutoff for inferred links; revisit if model weights change.
 */
export const INFERRED_LINK_THRESHOLD = -13

/**
 * Identifier attributes used for veto and scoring.
 */
const IDENTIFIER_VETO_KEYS = ["frn", "form499ID", "providerID"] as const

/**
 * Check whether records share an authoritative identifier.
 * Missing values are unknown, not evidence of a mismatch.
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

/**
 * Fixed Fellegi-Sunter model used by the inferred-link scorer.
 */
const INFERRED_SCORING_MODEL = buildDefaultModel({
	collapseSpatial: true,
	exactDiscriminators: [...IDENTIFIER_VETO_KEYS],
})

/**
 * Reject pairs without a shared identifier; otherwise return their Fellegi-Sunter score.
 */
function scoreWithIdentifierVeto(a: SourceRecord, b: SourceRecord): number {
	if (!hasSharedIdentifier(a, b)) return Number.NEGATIVE_INFINITY

	return scorePair(INFERRED_SCORING_MODEL, a, b).weight
}

/**
 * Rows per `filer_cluster` insert batch, below SQLite's parameter limit.
 */
const CLUSTER_INSERT_BATCH_SIZE = 500

/**
 * Counts returned by {@linkcode clusterAuthoritativeComponents}.
 */
export interface AuthoritativeClusterResult {
	/**
	 * Connected components, including singletons.
	 */
	clusters: number
	/**
	 * Nodes assigned to authoritative clusters.
	 */
	nodes: number
}

/**
 * Counts returned by {@linkcode clusterInferredLinks}.
 */
export interface InferredClusterResult {
	/**
	 * Form 499 nodes with legal names that canonicalized to a non-empty organization.
	 */
	recordsConsidered: number
	/**
	 * Multi-record entities returned by `resolveEntities`.
	 */
	linkedClusters: number
	/**
	 * Inferred edges written, one per non-representative member.
	 */
	links: number
}

/**
 * Options for inferred clustering and the combined clustering pass.
 */
export interface ClusterFilersOptions {
	/**
	 * Run label written to `source_vintage` and used to identify same-vintage rebuilds.
	 * It is not a temporal date; see `validFrom`.
	 */
	sourceVintage: string
	/**
	 * ISO effective date for temporal fields, separate from the run label.
	 */
	validFrom: string
	onProgress?: (message: string) => void
}

/**
 * The combined result of {@linkcode clusterFilers}.
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
 * Deduplicate, sort, and join codes for `resolveEntities`; return an empty string when no codes exist.
 */
function codeSetString(values: Iterable<string>): string {
	return [...new Set(values)].toSorted().join(" ")
}

/**
 * Read node identifiers keyed by `node_id`.
 */
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
 * Cluster nodes using only authoritative identity edges.
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

	// Every edge has infinite weight, so any finite threshold includes it.
	return cluster(nodeIDs, links, { threshold: 0 })
}

/**
 * Cluster authoritative edges and replace authoritative `filer_cluster` rows transactionally.
 */
export async function clusterAuthoritativeComponents(db: Kysely<FilerDatabase>): Promise<AuthoritativeClusterResult> {
	const groups = await readAuthoritativeGroups(db)

	const rows: FilerClusterTable[] = groups.flatMap((group) => {
		// Derive IDs from cluster contents for stable reruns.
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
 * Read each node's latest Form 499 legal name by ISO vintage.
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
 * Build candidate records for Form 499 nodes with non-empty canonical legal names.
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

		// Reject names that canonicalize to an empty string; they cannot form a blocking key.
		if (!organization || !organization.canonical) continue

		const group = groupOfNode.get(nodeID) ?? [nodeID]

		const attributes: Record<string, string> = {}
		const frnCodes = codesByType(group, FilerIdentifierType.FRN)
		const form499Codes = codesByType(group, FilerIdentifierType.Form499ID)
		const providerCodes = codesByType(group, FilerIdentifierType.BDCProviderID)

		// Omit absent codes so the scorer treats them as missing evidence, not as mismatches.
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
 * Infer Form 499 links and refresh inferred clusters and edges.
 */
export async function clusterInferredLinks(
	db: Kysely<FilerDatabase>,
	options: ClusterFilersOptions
): Promise<InferredClusterResult> {
	const progress = options.onProgress ?? (() => {})

	// Validate the temporal date before querying or writing.
	const validFrom = assertISODate(options.validFrom, "options.validFrom", "clusterInferredLinks")

	const records = await buildInferredRecords(db)

	progress(`pass (b): scoring ${records.length.toLocaleString()} form499_id record(s) with a legal name`)

	const { entities } = resolveEntities(records, {
		// filer.db has no default geo/contact blocking fields; block on canonical organization name.
		blockingKeys: [exactKey((record: SourceRecord) => record.organization?.canonical)],
		// Keep identifier comparisons explicit; the custom scorer below determines pair weights.
		exactDiscriminators: [...IDENTIFIER_VETO_KEYS],
		// The bundled learned scorer targets NPPES data, not corporate legal names.
		learnedScorer: false,
		// Require a shared FRN, Form 499 ID, or provider ID before scoring names.
		scorer: scoreWithIdentifierVeto,
		threshold: INFERRED_LINK_THRESHOLD,
	})

	const clusterRows: FilerClusterTable[] = []
	let linkedClusters = 0
	let links = 0

	await db.transaction().execute(async (trx) => {
		// Delete prior output for this source vintage; close still-open edges from earlier effective dates.
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
			// Derive IDs from cluster contents for stable reruns.
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
						// The inferred link asserts that both Form 499 IDs identify the same filer.
						relationship: FilerRelationship.SameEntity,
						source: CLUSTER_FILERS_SOURCE,
						source_vintage: options.sourceVintage,
						valid_from: validFrom,
						valid_to: null,
						match_score: entity.cohesion,
						evidence: stringifyJSON({ memberNodeIDs }),
					})
					// Earlier vintages were closed and this vintage was cleared above; retain conflict safety.
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
 * Run authoritative and inferred clustering passes in sequence.
 */
export async function clusterFilers(
	db: Kysely<FilerDatabase>,
	options: ClusterFilersOptions
): Promise<ClusterFilersResult> {
	const authoritative = await clusterAuthoritativeComponents(db)
	const inferred = await clusterInferredLinks(db, options)

	return { authoritative, inferred }
}
