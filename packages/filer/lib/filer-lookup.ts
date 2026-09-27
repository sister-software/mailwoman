/**
 * Identity crosswalk reader for filer identifiers.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { isoDate } from "@mailwoman/core/utils"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { isFRN, type FRN } from "#frn"
import {
	FILER_FAMILY_SCHEMA_VERSION,
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	readFilerManifest,
	type FilerDatabase,
	type FilerNodeTable,
} from "#schema"

/**
 * A lookup query.
 * Exactly one identifier must be provided.
 */
export interface FilerLookupQuery {
	frn?: FRN
	form499ID?: string
	bdcProviderID?: number
	asOf?: string
}

/**
 * One same-entity identifier for the queried node.
 */
export interface FilerLookupIdentifier {
	type: string
	value: string
	source: string
	source_vintage: string
}

/**
 * Authoritative cluster for the queried node, scoped to `asOf`.
 */
export interface FilerLookupCluster {
	cluster_id: string
	members: string[]
}

/**
 * One inferred link for the queried node.
 */
export interface FilerLookupInferredLink {
	to: string
	score: number | null
	source: string
}

/**
 * One family membership for the queried node.
 */
export interface FilerLookupFamily {
	family_id: string
	relationship: string
	/**
	 * Membership assertion strength.
	 */
	assertion: string
	/**
	 * The match score.
	 * An authoritative row carries null.
	 */
	match_score: number | null
	display_names: string[]
}

export interface FilerLookupResult {
	node: FilerNodeTable
	identifiers: FilerLookupIdentifier[]
	/**
	 * Latest filer attributes by key for the queried node.
	 */
	attributes: Record<string, string>
	cluster: FilerLookupCluster | null
	inferred_links: FilerLookupInferredLink[]
	/**
	 * Family memberships for the queried node.
	 */
	families: FilerLookupFamily[]
	/**
	 * Derived primary FRN when multiple FRNs are present.
	 */
	primary_frn: FilerLookupPrimaryFRN | null
	/**
	 * Effective date for temporal filtering.
	 */
	as_of: string
	/**
	 * Manifest source vintage.
	 */
	vintage: string
}

/**
 * Shape for derived primary FRN output.
 */
export interface FilerLookupPrimaryFRN {
	frn: FRN
	/**
	 * Derivation rule identifier.
	 */
	derived_from: string
	/**
	 * Date used to compute this derived value.
	 */
	as_of: string
}

/**
 * Derivation key for the primary FRN rule.
 */
export const PRIMARY_FRN_DERIVATION = "most-recent-499-filing"

/**
 * Input record for primary FRN selection.
 */
export interface FRNFilingRecord {
	frn: FRN
	filedAt: string
}

/**
 * Pick the FRN with the latest filing date.
 */
export function pickPrimaryFRN(candidates: readonly FRNFilingRecord[]): FRN {
	if (!candidates.length) {
		throw new Error("pickPrimaryFRN: at least one candidate is required — there is no primary FRN of nothing")
	}

	let latest = candidates[0]!

	for (const candidate of candidates) {
		if (candidate.filedAt > latest.filedAt) {
			latest = candidate
		}
	}

	return latest.frn
}

/**
 * Read FRN filing candidates in force at `asOf`.
 */
export async function readFRNFilingCandidates(
	db: DatabaseClient<FilerDatabase>,
	frns: readonly FRN[],
	asOf: string
): Promise<FRNFilingRecord[]> {
	const candidates: FRNFilingRecord[] = []

	for (const frn of frns) {
		const frnNodeID = `${FilerIdentifierType.FRN}:${frn}`

		const filingEdges = await db
			.selectFrom("filer_edge")
			.select(["valid_from"])
			.where("assertion", "=", FilerEdgeAssertion.Authoritative)
			.where("source", "=", "form-499")
			.where("from_node_id", "=", frnNodeID)
			.where("valid_from", "<=", asOf)
			.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
			.execute()

		if (!filingEdges.length) continue

		let latestFiledAt = filingEdges[0]!.valid_from

		for (const edge of filingEdges) {
			if (edge.valid_from > latestFiledAt) {
				latestFiledAt = edge.valid_from
			}
		}

		candidates.push({ frn, filedAt: latestFiledAt })
	}

	return candidates
}

interface QueriedIdentifier {
	nodeID: string
	type: string
	value: string
}

/**
 * Resolve the single requested identifier into a node ID.
 */
function resolveQueriedIdentifier(query: FilerLookupQuery): QueriedIdentifier {
	const suppliedCount =
		(query.frn !== undefined ? 1 : 0) +
		(query.form499ID !== undefined ? 1 : 0) +
		(query.bdcProviderID !== undefined ? 1 : 0)

	if (suppliedCount !== 1) {
		throw new Error("filerLookup: exactly one of `frn`, `form499ID`, `bdcProviderID` is required")
	}

	if (query.frn !== undefined) {
		return { nodeID: `${FilerIdentifierType.FRN}:${query.frn}`, type: FilerIdentifierType.FRN, value: query.frn }
	}

	if (query.form499ID !== undefined) {
		return {
			nodeID: `${FilerIdentifierType.Form499ID}:${query.form499ID}`,
			type: FilerIdentifierType.Form499ID,
			value: query.form499ID,
		}
	}

	const value = String(query.bdcProviderID)

	return { nodeID: `${FilerIdentifierType.BDCProviderID}:${value}`, type: FilerIdentifierType.BDCProviderID, value }
}

/**
 * Return today's date in ISO format.
 */
// repo-health-ignore export-name-affix -- the name is the point: one definition of "today" for this SDK's `asOf`.
export function todayISODate(): string {
	return isoDate()
}

/**
 * Ensure the DB schema supports `filer_family`.
 */
export function assertFamilySchemaVersion(schemaVersion: number, readerName: string): void {
	if (schemaVersion < FILER_FAMILY_SCHEMA_VERSION) {
		throw new Error(
			`${readerName}: filer.db schema_version ${schemaVersion} predates filer_family (introduced at ` +
				`schema_version ${FILER_FAMILY_SCHEMA_VERSION}) — rebuild this artifact via ` +
				"buildFilerDatabase to pick up the current schema before querying it with this reader."
		)
	}
}

/**
 * Internal `filer_family` member row shape.
 */
export interface FamilyMemberRow {
	node_id: string
	/**
	 * Naming node used to derive `family_id`.
	 */
	naming_node_id: string
	relationship: string
	/**
	 * Assertion strength for this membership.
	 */
	assertion: string
	source: string
	valid_from: string
	match_score: number | null
}

/**
 * Read family members in force at `asOf`.
 */
export async function readFamilyMembers(
	db: DatabaseClient<FilerDatabase>,
	familyID: string,
	asOf: string
): Promise<FamilyMemberRow[]> {
	// Keep result order deterministic.
	return db
		.selectFrom("filer_family")
		.select(["node_id", "naming_node_id", "relationship", "assertion", "source", "valid_from", "match_score"])
		.where("family_id", "=", familyID)
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.orderBy("node_id")
		.orderBy("naming_node_id")
		.orderBy("source")
		.orderBy("valid_from")
		.execute()
}

/**
 * Read distinct display names implied by current family member edges.
 */
export async function readFamilyDisplayNames(
	db: DatabaseClient<FilerDatabase>,
	members: readonly FamilyMemberRow[]
): Promise<string[]> {
	const displayNames = new Set<string>()

	for (const member of members) {
		const edgeRows = await db
			.selectFrom("filer_edge")
			.innerJoin("filer_node", "filer_node.node_id", "filer_edge.to_node_id")
			.select("filer_node.identifier_value")
			.where("filer_edge.from_node_id", "=", member.node_id)
			// Join by the stored naming node.
			.where("filer_edge.to_node_id", "=", member.naming_node_id)
			// Allow inferred rows only for the Edgar source.
			.where((eb) =>
				eb.or([
					eb("filer_edge.assertion", "=", FilerEdgeAssertion.Authoritative),
					eb.and([
						eb("filer_edge.assertion", "=", FilerEdgeAssertion.Inferred),
						eb("filer_edge.source", "=", "edgar-exhibit-21"),
					]),
				])
			)
			.where("filer_edge.relationship", "=", member.relationship)
			.where("filer_edge.source", "=", member.source)
			.where("filer_edge.valid_from", "=", member.valid_from)
			.execute()

		for (const row of edgeRows) {
			displayNames.add(row.identifier_value)
		}
	}

	return [...displayNames].toSorted()
}

function otherEndOf(edge: { from_node_id: string; to_node_id: string }, nodeID: string): string {
	return edge.from_node_id === nodeID ? edge.to_node_id : edge.from_node_id
}

/**
 * Return a node from the map or throw if missing.
 */
function nodeOrThrow(byID: ReadonlyMap<string, FilerNodeTable>, nodeID: string): FilerNodeTable {
	const node = byID.get(nodeID)

	if (!node) {
		throw new Error(
			`filerLookup: filer_edge references node_id ${stringifyJSON(nodeID)} with no matching filer_node row — corrupted crosswalk`
		)
	}

	return node
}

/**
 * Derive cluster members reachable by authoritative same-entity edges at `asOf`.
 */
async function deriveClusterMembersAsOf(
	db: DatabaseClient<FilerDatabase>,
	nodeID: string,
	candidateMembers: readonly string[],
	asOf: string
): Promise<string[] | null> {
	// No corroborating relationship exists for singleton sets.
	if (candidateMembers.length <= 1) return null

	// Chunk to stay under SQLite variable limits.
	const MEMBER_CHUNK = 8000
	const edges: Array<{ from_node_id: string; to_node_id: string }> = []

	for (let offset = 0; offset < candidateMembers.length; offset += MEMBER_CHUNK) {
		edges.push(
			...(await db
				.selectFrom("filer_edge")
				.select(["from_node_id", "to_node_id"])
				.where("assertion", "=", FilerEdgeAssertion.Authoritative)
				.where("relationship", "=", FilerRelationship.SameEntity)
				.where("from_node_id", "in", candidateMembers.slice(offset, offset + MEMBER_CHUNK))
				.where("valid_from", "<=", asOf)
				.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
				.execute())
		)
	}

	const adjacency = new Map<string, Set<string>>(candidateMembers.map((member) => [member, new Set<string>()]))

	for (const edge of edges) {
		adjacency.get(edge.from_node_id)?.add(edge.to_node_id)
		adjacency.get(edge.to_node_id)?.add(edge.from_node_id)
	}

	const visited = new Set<string>([nodeID])
	const queue = [nodeID]

	while (queue.length) {
		const current = queue.shift()!

		for (const neighbor of adjacency.get(current) ?? []) {
			if (!visited.has(neighbor)) {
				visited.add(neighbor)
				queue.push(neighbor)
			}
		}
	}

	if (visited.size <= 1) return null

	return [...visited].toSorted()
}

/**
 * Ensure a string is a valid FRN.
 */
function assertFRNIdentifier(value: string): FRN {
	if (!isFRN(value)) {
		throw new Error(
			`filerLookup: an frn-typed identifier carries ${stringifyJSON(value)}, which is not a valid FRN ` +
				`(expected a zero-padded 10-digit string) — corrupted crosswalk`
		)
	}

	return value
}

/**
 * Read identity-crosswalk data for one identifier.
 */
export async function filerLookup(
	db: DatabaseClient<FilerDatabase>,
	query: FilerLookupQuery
): Promise<FilerLookupResult> {
	const { nodeID, type, value } = resolveQueriedIdentifier(query)

	// Validate manifest first.
	const manifest = await readFilerManifest(db)

	// Ensure family table is available.
	assertFamilySchemaVersion(manifest.schema_version, "filerLookup")

	const asOf = query.asOf ?? todayISODate()

	const node = await db.selectFrom("filer_node").selectAll().where("node_id", "=", nodeID).executeTakeFirst()

	if (!node) {
		throw new Error(`filerLookup: no ${type} node found for value ${stringifyJSON(value)}`)
	}

	// Same-entity authoritative edges in force at `asOf`.
	const authoritativeEdges = await db
		.selectFrom("filer_edge")
		.selectAll()
		.where("assertion", "=", FilerEdgeAssertion.Authoritative)
		.where("relationship", "=", FilerRelationship.SameEntity)
		.where((eb) => eb.or([eb("from_node_id", "=", nodeID), eb("to_node_id", "=", nodeID)]))
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.execute()

	const otherNodeIDs = new Set(authoritativeEdges.map((edge) => otherEndOf(edge, nodeID)))

	const otherNodes = otherNodeIDs.size
		? await db
				.selectFrom("filer_node")
				.selectAll()
				.where("node_id", "in", [...otherNodeIDs])
				.execute()
		: []

	const nodeByID = new Map(otherNodes.map((n) => [n.node_id, n] as const))

	// Preserve one identifier entry per authoritative edge.
	const identifiers: FilerLookupIdentifier[] = authoritativeEdges.map((edge) => {
		const otherNode = nodeOrThrow(nodeByID, otherEndOf(edge, nodeID))

		return {
			type: otherNode.identifier_type,
			value: otherNode.identifier_value,
			source: edge.source,
			source_vintage: edge.source_vintage,
		}
	})

	const attributeRows = await db.selectFrom("filer_attribute").selectAll().where("node_id", "=", nodeID).execute()

	const latestAttributeByKey = new Map<string, { value: string; vintage: string }>()

	for (const row of attributeRows) {
		const current = latestAttributeByKey.get(row.key)

		if (!current || row.source_vintage > current.vintage) {
			latestAttributeByKey.set(row.key, { value: row.value, vintage: row.source_vintage })
		}
	}

	const attributes: Record<string, string> = {}

	for (const [key, { value: attrValue }] of latestAttributeByKey) {
		attributes[key] = attrValue
	}

	// Read authoritative cluster snapshot row.
	const clusterRow = await db
		.selectFrom("filer_cluster")
		.selectAll()
		.where("node_id", "=", nodeID)
		.where("assertion", "=", FilerEdgeAssertion.Authoritative)
		.executeTakeFirst()

	let cluster: FilerLookupCluster | null = null

	if (clusterRow) {
		const memberRows = await db
			.selectFrom("filer_cluster")
			.select("node_id")
			.where("cluster_id", "=", clusterRow.cluster_id)
			.where("assertion", "=", FilerEdgeAssertion.Authoritative)
			.orderBy("node_id")
			.execute()

		// Corroborate membership against in-force authoritative edges.
		const membersAsOf = await deriveClusterMembersAsOf(
			db,
			nodeID,
			memberRows.map((row) => row.node_id),
			asOf
		)

		if (membersAsOf) {
			cluster = { cluster_id: clusterRow.cluster_id, members: membersAsOf }
		}
	}

	// Read inferred edges separately.
	const inferredEdges = await db
		.selectFrom("filer_edge")
		.selectAll()
		.where("assertion", "=", FilerEdgeAssertion.Inferred)
		.where((eb) => eb.or([eb("from_node_id", "=", nodeID), eb("to_node_id", "=", nodeID)]))
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.execute()

	const inferred_links: FilerLookupInferredLink[] = inferredEdges.map((edge) => ({
		to: otherEndOf(edge, nodeID),
		score: edge.match_score,
		source: edge.source,
	}))

	// Read distinct family memberships for this node in force at `asOf`.
	const familyRows = await db
		.selectFrom("filer_family")
		.select(["family_id", "relationship", "assertion", "match_score"])
		.distinct()
		.where("node_id", "=", nodeID)
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.orderBy("family_id")
		.orderBy("relationship")
		.orderBy("assertion")
		.orderBy("match_score")
		.execute()

	// Compute family-wide display names per family.
	const families: FilerLookupFamily[] = []

	for (const row of familyRows) {
		const familyMembers = await readFamilyMembers(db, row.family_id, asOf)
		const displayNames = await readFamilyDisplayNames(db, familyMembers)

		families.push({
			family_id: row.family_id,
			relationship: row.relationship,
			assertion: row.assertion,
			match_score: row.match_score,
			display_names: displayNames,
		})
	}

	// Derive primary FRN when multiple FRN identifiers exist.
	const frnIdentifiers = identifiers.filter((identifier) => identifier.type === FilerIdentifierType.FRN)

	let primaryFRN: FilerLookupPrimaryFRN | null = null

	if (frnIdentifiers.length > 1) {
		const candidates = await readFRNFilingCandidates(
			db,
			frnIdentifiers.map((identifier) => assertFRNIdentifier(identifier.value)),
			asOf
		)

		if (candidates.length) {
			primaryFRN = { frn: pickPrimaryFRN(candidates), derived_from: PRIMARY_FRN_DERIVATION, as_of: asOf }
		}
	}

	return {
		node,
		identifiers,
		attributes,
		cluster,
		inferred_links,
		families,
		primary_frn: primaryFRN,
		as_of: asOf,
		vintage: manifest.source_vintage,
	}
}
