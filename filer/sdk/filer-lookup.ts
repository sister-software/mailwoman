/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `filerLookup` — the identity-crosswalk reader (3a Task 7) and the module the four pre-registered 3a
 *   acceptance gates live against (`describe("§7-3a gates")` in `filer-lookup.test.ts`; see
 *   `docs/superpowers/plans/2026-07-31-filer-3a-plan.md`'s "Acceptance gates (§7-3a…)" section for the
 *   gates verbatim). One identifier in — `frn` XOR `form499ID` XOR `bdcProviderID`, matching
 *   `filingLandscape`'s XOR discipline (`bdc/sdk/filing-landscape.ts`) — one crosswalk view out: every
 *   identifier this node shares an AUTHORITATIVE edge with, its flattened current attributes, its
 *   authoritative cluster (never touched by an inferred edge — decision 5 / gate 2), and its inferred
 *   links reported SEPARATELY with their score/source. Every relationship in the answer is scoped `asOf`
 *   a date (default: today), and `as_of` is always present in the result so a caller never has to guess
 *   which view they got.
 *
 *   **Manifest-first (gate 4's "always stamped" half).** `readFilerManifest` runs before any node/edge
 *   query — a missing/broken manifest throws immediately (matching `filingLandscape`'s own ordering)
 *   rather than this reader ever answering with a made-up or missing `vintage`.
 *
 *   **Temporal scoping (gate 4).** An edge is "in force" `asOf` a date when `valid_from <= asOf AND
 *   (valid_to IS NULL OR asOf < valid_to)` — the same half-open-interval convention `cluster-filers.ts`'s
 *   cross-vintage supersession already commits to (`valid_to` marks the date an assertion STOPPED
 *   holding, not the last date it held). Applied identically to `identifiers` and `inferred_links`.
 *
 *   **Authoritative/inferred never conflated (gate 2).** `cluster` is read from `filer_cluster WHERE
 *   assertion = 'authoritative'` ONLY; `inferred_links` is read from `filer_edge WHERE assertion =
 *   'inferred'` ONLY — two disjoint queries against two disjoint slices. There is no code path here that
 *   could fold an inferred relationship into the authoritative `cluster` field: the same guarantee
 *   `cluster-filers.ts` makes on the write side (decision 5), restated here on the read side.
 *
 *   **Primary-FRN rule (gate 3, decision 6).** A `bdc_provider_id` node can carry more than one
 *   authoritative FRN edge (Task 3: one `provider_id` can appear on multiple provider-list rows under
 *   different FRNs) — `identifiers` reports ALL of them, never collapsed. When more than one FRN
 *   identifier is found, {@linkcode pickPrimaryFRN} — the documented rule decision 6 describes for Task
 *   8's `bdc_provider` population ("the primary FRN is the one from the most recent 499 filing date") —
 *   picks a winner from each FRN's own most recent `form-499` filing edge, surfaced as
 *   `attributes.primary_frn`. The rule is a pure, exported function here (Task 8's `bdc/sdk/build-bdc.ts`
 *   is the actual future consumer — this is not that task) so it has exactly one home and one pinning
 *   test, ready to import.
 */

import type { DatabaseClient } from "@mailwoman/core/kysley/client"

import {
	FilerEdgeAssertion,
	FilerIdentifierType,
	readFilerManifest,
	type FilerDatabase,
	type FilerNodeTable,
} from "../schema.ts"
import type { FRN } from "./frn.ts"

/**
 * Exactly one of `frn`/`form499ID`/`bdcProviderID` is required — {@linkcode filerLookup} throws otherwise (matching
 * `filingLandscape`'s XOR discipline). `asOf` defaults to today (see {@linkcode filerLookup}); every temporal
 * comparison in the result — `identifiers`, `inferred_links` — is scoped to it.
 */
export interface FilerLookupQuery {
	frn?: FRN
	form499ID?: string
	bdcProviderID?: number
	asOf?: string
}

/**
 * One OTHER identifier the queried node shares an AUTHORITATIVE edge with, `asOf` the query's date. `type` is one of
 * {@link FilerIdentifierType}.
 */
export interface FilerLookupIdentifier {
	type: string
	value: string
	source: string
	source_vintage: string
}

/**
 * The queried node's AUTHORITATIVE cluster (gate 2) — `null` when clustering (`cluster-filers.ts`) has never been run,
 * or the node carries no authoritative cluster assignment. `members` are `filer_node.node_id`s.
 */
export interface FilerLookupCluster {
	cluster_id: string
	members: string[]
}

/**
 * One INFERRED relationship the queried node carries, `asOf` the query's date — reported SEPARATELY from
 * {@link FilerLookupResult.cluster} (gate 2), never merged into it. `to` is the other end's `filer_node.node_id`.
 */
export interface FilerLookupInferredLink {
	to: string
	score: number | null
	source: string
}

export interface FilerLookupResult {
	node: FilerNodeTable
	identifiers: FilerLookupIdentifier[]
	/**
	 * Flattened `filer_attribute` facts for the queried node — one value per `key`, the LATEST `source_vintage` winning
	 * on a repeat key (same plain-string-comparison convention as `cluster-filers.ts`'s `readLatestLegalNames`; see that
	 * function's docstring for the "lexicographically greatest, not date-parsed" caveat). May additionally carry
	 * `primary_frn` — see the module docstring's "Primary-FRN rule" section.
	 */
	attributes: Record<string, string>
	cluster: FilerLookupCluster | null
	inferred_links: FilerLookupInferredLink[]
	/**
	 * The date every temporal comparison in this result was scoped to — ALWAYS present, whether supplied by the caller or
	 * defaulted to today (gate 4).
	 */
	as_of: string
	/**
	 * `filer_manifest.source_vintage` — read (and validated) before any node/edge query (see the module docstring).
	 */
	vintage: string
}

/**
 * One FRN's own most recent `form-499` filing date — the input shape {@linkcode pickPrimaryFRN} consumes.
 */
export interface FRNFilingRecord {
	frn: FRN
	filedAt: string
}

/**
 * Decision 6's primary-FRN rule: given every FRN a `bdc_provider_id` carries (cardinality preserved in the graph — see
 * the module docstring's gate 3 section), picks the one with the most recent 499 filing date. "Most recent" is a plain
 * string comparison over `filedAt` (ISO-sortable filing dates), the same convention `cluster-filers.ts`'s
 * `readLatestLegalNames` uses for the identical reason. A tie keeps whichever candidate appears first in `candidates`
 * (deterministic, not meaningful — a genuine same-day double-filing under two different FRNs is not a case decision 6
 * resolves). Throws on an empty input: there is no "primary" of nothing.
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

interface QueriedIdentifier {
	nodeID: string
	type: string
	value: string
}

/**
 * XOR discipline (matching `filingLandscape`'s `queryModeCount` check) plus node-id minting for whichever of
 * `frn`/`form499ID`/`bdcProviderID` was supplied.
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
 * `new Date().toISOString().slice(0, 10)` — today, as an ISO `YYYY-MM-DD` date string, the same sortable shape every
 * real `valid_from`/`valid_to` in `filer.db` uses. {@linkcode filerLookup}'s default `asOf` when the caller omits one.
 */
function todayISODate(): string {
	return new Date().toISOString().slice(0, 10)
}

function otherEndOf(edge: { from_node_id: string; to_node_id: string }, nodeID: string): string {
	return edge.from_node_id === nodeID ? edge.to_node_id : edge.from_node_id
}

/**
 * Look up a node in `byID`, throwing on a miss — every `filer_edge` row this reader touches MUST resolve to a real
 * `filer_node` row on both ends (referential integrity `filer.db`'s builder guarantees by construction); a miss means a
 * corrupted crosswalk, not a legitimate "not found" case, so this is loud rather than silently dropping the
 * identifier.
 */
function nodeOrThrow(byID: ReadonlyMap<string, FilerNodeTable>, nodeID: string): FilerNodeTable {
	const node = byID.get(nodeID)

	if (!node) {
		throw new Error(
			`filerLookup: filer_edge references node_id ${JSON.stringify(nodeID)} with no matching filer_node row — corrupted crosswalk`
		)
	}

	return node
}

/**
 * Read the identity crosswalk for one identifier — see the module docstring for the full contract (XOR query,
 * manifest-first, temporal scoping, the authoritative/inferred split, and the primary-FRN rule).
 */
export async function filerLookup(
	db: DatabaseClient<FilerDatabase>,
	query: FilerLookupQuery
): Promise<FilerLookupResult> {
	const { nodeID, type, value } = resolveQueriedIdentifier(query)

	// Manifest-first (gate 4): throws before any node/edge query runs at all — this reader never answers unstamped.
	const manifest = await readFilerManifest(db)

	const asOf = query.asOf ?? todayISODate()

	const node = await db.selectFrom("filer_node").selectAll().where("node_id", "=", nodeID).executeTakeFirst()

	if (!node) {
		throw new Error(`filerLookup: no ${type} node found for value ${JSON.stringify(value)}`)
	}

	// Gate 4: temporal scoping. valid_from <= asOf AND (valid_to IS NULL OR asOf < valid_to) — see the module
	// docstring. Applied identically to the authoritative edges below and the inferred edges further down.
	const authoritativeEdges = await db
		.selectFrom("filer_edge")
		.selectAll()
		.where("assertion", "=", FilerEdgeAssertion.Authoritative)
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

	// Gate 3 (cardinality fidelity): every authoritative edge becomes its own identifiers[] entry — a
	// bdcProviderID carrying two FRN edges reports BOTH, never collapsed/deduped.
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

	// Gate 2: `cluster` is read ONLY from assertion = 'authoritative' rows — see the module docstring.
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

		cluster = { cluster_id: clusterRow.cluster_id, members: memberRows.map((row) => row.node_id) }
	}

	// Gate 2: `inferred_links` is read ONLY from assertion = 'inferred' rows, entirely separately from `cluster`
	// above — the two never share a query, so an inferred edge can never leak into the authoritative view.
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

	// Gate 3 / decision 6: when the queried node carries more than one FRN identifier (the multi-FRN provider_id
	// cardinality case), pick a primary via each FRN's own most recent form-499 filing edge.
	const frnIdentifiers = identifiers.filter((identifier) => identifier.type === FilerIdentifierType.FRN)

	if (frnIdentifiers.length > 1) {
		const candidates: FRNFilingRecord[] = []

		for (const frnIdentifier of frnIdentifiers) {
			const frnNodeID = `${FilerIdentifierType.FRN}:${frnIdentifier.value}`

			const filingEdges = await db
				.selectFrom("filer_edge")
				.select(["valid_from"])
				.where("assertion", "=", FilerEdgeAssertion.Authoritative)
				.where("source", "=", "form-499")
				.where("from_node_id", "=", frnNodeID)
				.where("valid_from", "<=", asOf)
				.execute()

			if (!filingEdges.length) continue

			let latestFiledAt = filingEdges[0]!.valid_from

			for (const edge of filingEdges) {
				if (edge.valid_from > latestFiledAt) {
					latestFiledAt = edge.valid_from
				}
			}

			candidates.push({ frn: frnIdentifier.value as FRN, filedAt: latestFiledAt })
		}

		if (candidates.length) {
			attributes.primary_frn = pickPrimaryFRN(candidates)
		}
	}

	return {
		node,
		identifiers,
		attributes,
		cluster,
		inferred_links,
		as_of: asOf,
		vintage: manifest.source_vintage,
	}
}
