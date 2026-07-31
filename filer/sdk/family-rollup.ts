/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `familyRollup` (3b Task 3) — the corporate-family reader. A CORPORATE FAMILY (a holding/parent/
 *   subsidiary/management tree spanning several DIFFERENT filers) is a rollup spec §4.1 keeps deliberately
 *   SEPARATE from an entity cluster (same filer, different identifiers — `cluster-filers.ts` /
 *   `filer-lookup.ts`'s `cluster` field). This module reads ONLY `filer_family`; it never touches
 *   `filer_cluster` or the authoritative-edge entity-clustering path, so a family membership can never be
 *   returned here as an entity-cluster member, and this reader cannot be the source of the conflation gate
 *   1 (`filer-lookup.test.ts`'s `describe("§7-3b gates")`) exists to catch.
 *
 *   Query shape mirrors `filerLookup`'s XOR discipline: exactly one of `familyID`/`nodeID` is required.
 *   Given a `familyID`, this returns that one family's membership (0 or 1 elements — see the return-shape
 *   note below). Given a `nodeID`, it resolves EVERY family (if any) that node belongs to as of that date
 *   and returns the full rollup for each — a node CAN legitimately belong to more than one family at once
 *   (Task 2's own fixtures: a filer whose holding company differs from its management company gets two
 *   DIFFERENT family memberships), and this is a normal shape, not an exceptional one to guess around or
 *   refuse (task 3 fix round 1, IMPORTANT-2 — the original version threw on this case; `filerLookup.ts`'s
 *   own `families` field answers the identical "which families does this node belong to" question with an
 *   array, so the two surfaces would otherwise disagree about whether a normal multi-family shape is
 *   exceptional).
 *
 *   **Return shape (task 3 fix round 1, IMPORTANT-2): always `FamilyRollup[]`, never `null` or a bare
 *   object.** Empty when nothing is found — by `familyID`, when that family has no member row in force
 *   `asOf` the date (including when it has never existed at all); by `nodeID`, when that node belongs to no
 *   family as of that date. A `familyID` query returns at most one element (a `family_id` names exactly one
 *   family); a `nodeID` query may return more than one.
 *
 *   Manifest-first, same as `filerLookup`: `readFilerManifest` runs before any `filer_family` query, so this
 *   reader never answers with a made-up or missing `vintage`. Immediately after, {@linkcode
 *   assertFamilySchemaVersion} (`filer-lookup.ts`, task 3 fix round 1, IMPORTANT-3) refuses an artifact
 *   whose `schema_version` predates `filer_family` with a descriptive, rebuild-pointing error. `asOf`
 *   defaults to today via {@linkcode todayISODate}, imported from `filer-lookup.ts` rather than redefined
 *   here, so every reader in this SDK shares one definition of "today."
 *
 *   Temporal scoping copies `filer-lookup.ts`'s exact half-open predicate verbatim — `valid_from <= asOf AND
 *   (valid_to IS NULL OR valid_to > asOf)` — rather than reimplementing it: three separate 3a tasks fixed
 *   this same class of bug independently before the final review caught them diverging, and the task brief
 *   for this module names that history explicitly as the reason to copy, not rewrite.
 */

import type { DatabaseClient } from "@mailwoman/core/kysley/client"

import { readFilerManifest, type FilerDatabase } from "../schema.ts"
import { assertFamilySchemaVersion, todayISODate } from "./filer-lookup.ts"

/**
 * Exactly one of `familyID`/`nodeID` is required — {@linkcode familyRollup} throws otherwise. `asOf` defaults to today
 * (see {@linkcode todayISODate}).
 */
export interface FamilyRollupQuery {
	familyID?: string
	nodeID?: string
	asOf?: string
}

/**
 * One member of a corporate family, `asOf` the query's date — `relationship` is one of {@link FilerRelationship}
 * (`schema.ts`), and `source` is the `filer_family` row's own provenance. Never collapsed on a repeat `node_id`: two
 * different sources independently asserting the same node's membership in the same family both survive as separate
 * entries, the same provenance-plurality convention every other reader in this SDK follows.
 */
export interface FamilyRollupMember {
	node_id: string
	relationship: string
	source: string
}

/**
 * {@linkcode familyRollup}'s per-family result shape — a corporate family's full membership, `asOf`-scoped.
 * Deliberately carries no `cluster_id`-shaped key and no single top-level `relationship`, unlike the OTHER family type
 * this SDK exports, `filer-lookup.ts`'s `FilerLookupFamily`, which answers "which families does ONE node belong to."
 * This is the inverse view, "who belongs to THIS family," so `relationship` lives per-member instead.
 *
 * `distinct_member_count` (task 3 fix round 1, MINOR) is `members` deduped by `node_id` — `members` itself is NEVER
 * deduped (provenance plurality: two different sources asserting the same node's membership both survive as separate
 * entries), so `members.length` alone over-counts whenever more than one source corroborates the same member. This
 * mirrors `filerLookup.ts`'s `cluster.members`, which IS already deduped (one entry per node) — without this field, a
 * caller sizing a family by array length would get an inconsistent answer depending on which rollup they read.
 */
export interface FamilyRollup {
	family_id: string
	members: FamilyRollupMember[]
	distinct_member_count: number
	as_of: string
	vintage: string
}

/**
 * Read a `familyID`'s rollup at `asOf` — `null` when it has no member row in force at that date (including when it has
 * never existed at all). Pulled out of {@linkcode familyRollup} so the `nodeID` path (task 3 fix round 1, IMPORTANT-2)
 * can call it once per distinct family a node belongs to, instead of duplicating the member-query logic.
 */
async function readFamilyRollup(
	db: DatabaseClient<FilerDatabase>,
	familyID: string,
	asOf: string,
	vintage: string
): Promise<FamilyRollup | null> {
	const memberRows = await db
		.selectFrom("filer_family")
		.select(["node_id", "relationship", "source"])
		.where("family_id", "=", familyID)
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.orderBy("node_id")
		.execute()

	if (!memberRows.length) {
		return null
	}

	return {
		family_id: familyID,
		members: memberRows,
		distinct_member_count: new Set(memberRows.map((row) => row.node_id)).size,
		as_of: asOf,
		vintage,
	}
}

/**
 * Read every corporate family a `familyID`/`nodeID` resolves to — see the module docstring for the full contract (XOR
 * query, manifest-first, schema-version guard, temporal scoping, the always-array return shape). A `familyID` query
 * returns at most one element; a `nodeID` query may return more than one (task 3 fix round 1, IMPORTANT-2 — a node
 * legitimately belonging to more than one family is a normal shape, never an error).
 */
export async function familyRollup(
	db: DatabaseClient<FilerDatabase>,
	query: FamilyRollupQuery
): Promise<FamilyRollup[]> {
	const suppliedCount = (query.familyID !== undefined ? 1 : 0) + (query.nodeID !== undefined ? 1 : 0)

	if (suppliedCount !== 1) {
		throw new Error("familyRollup: exactly one of `familyID`, `nodeID` is required")
	}

	// Manifest-first (matches filerLookup's discipline) — throws before any filer_family query runs at all.
	const manifest = await readFilerManifest(db)

	// Task 3 fix round 1, IMPORTANT-3: same guard as filerLookup — refuse a pre-filer_family artifact descriptively.
	assertFamilySchemaVersion(manifest.schema_version, "familyRollup")

	const asOf = query.asOf ?? todayISODate()

	if (query.familyID !== undefined) {
		const rollup = await readFamilyRollup(db, query.familyID, asOf, manifest.source_vintage)

		return rollup ? [rollup] : []
	}

	const nodeID = query.nodeID!

	// Resolve EVERY family this node belongs to as of asOf — same half-open predicate as every other temporal read
	// in this module. Never throws on >1 result (task 3 fix round 1, IMPORTANT-2): a node carrying both a
	// HoldingCompany and a ManagementCompany family membership is a normal, builder-emitted shape.
	const nodeFamilyRows = await db
		.selectFrom("filer_family")
		.select("family_id")
		.where("node_id", "=", nodeID)
		.where("valid_from", "<=", asOf)
		.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
		.execute()

	const distinctFamilyIDs = [...new Set(nodeFamilyRows.map((row) => row.family_id))]

	const rollups: FamilyRollup[] = []

	for (const familyID of distinctFamilyIDs) {
		const rollup = await readFamilyRollup(db, familyID, asOf, manifest.source_vintage)

		// Not expected to ever be null here — nodeFamilyRows just confirmed this node has an in-force row for this
		// exact familyID at this exact asOf, so readFamilyRollup's own identical predicate will find at least that
		// one member row. Guarded anyway rather than asserted, since silently trusting that invariant across two
		// separate queries is the same class of shortcut this crosswalk's design otherwise refuses to take.
		if (rollup) {
			rollups.push(rollup)
		}
	}

	return rollups
}
