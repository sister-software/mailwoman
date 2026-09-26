/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `familyRollup` — the corporate-family reader. A corporate family (a holding/parent/subsidiary/management tree
 * spanning several different filers) is a rollup spec §4.1 keeps deliberately separate from an entity cluster; this
 * module reads only `filer_family` and never `filer_cluster`, so a family membership can never be returned here as an
 * entity-cluster member.
 *
 * Exactly one of `familyID`/`nodeID` is required, mirroring `filerLookup`'s XOR discipline. The return is always
 * `FamilyRollup[]`, never `null`: empty when no row is found, at most one element for a `familyID` (a `family_id`
 * names exactly one family), and possibly more for a `nodeID`, because a node can legitimately belong to more than one
 * family at once.
 *
 * Manifest-first like `filerLookup`: `readFilerManifest` runs before any `filer_family` query, {@linkcode
 * assertFamilySchemaVersion} refuses a pre-`filer_family` artifact with a rebuild-pointing error, and `asOf` defaults
 * to today via `filer-lookup.ts`'s {@linkcode todayISODate} rather than a second definition of it.
 *
 * The half-open temporal predicate is copied verbatim from `filer-lookup.ts` — `valid_from <= asOf and (valid_to is
 * NULL or valid_to > asOf)` — because every reimplementation is another place for the readers to diverge.
 *
 * `members` grade themselves via `assertion`/`match_score` rather than `source`, because edgar's `edgar-exhibit-21`
 * writes an authoritative disclosure edge and an inferred corroboration in the same build, so one source name spans
 * both grades. See {@link FamilyRollupMember}.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { assertFamilySchemaVersion, readFamilyDisplayNames, readFamilyMembers, todayISODate } from "#filer-lookup"
import { readFilerManifest, type FilerDatabase } from "#schema"

/**
 * Exactly one of `familyID`/`nodeID` is required — {@linkcode familyRollup}
 * throws otherwise — and `asOf` defaults to today.
 */
export interface FamilyRollupQuery {
	familyID?: string
	nodeID?: string
	asOf?: string
}

/**
 * One member of a corporate family as of the query's date, never collapsed on a repeat `node_id`:
 * two sources independently asserting the same membership both survive as separate entries,
 * the provenance-plurality convention every reader in this SDK follows.
 */
export interface FamilyRollupMember {
	node_id: string
	relationship: string
	/**
	 * How strongly this member's membership is evidenced; carried even though `source`
	 * is present because `edgar-exhibit-21` writes an authoritative edge and an inferred
	 * corroboration in the same build, so one source name spans both grades.
	 */
	assertion: string
	/**
	 * The inferred match's score, `null` on an authoritative membership.
	 */
	match_score: number | null
	source: string
}

/**
 * {@linkcode familyRollup}'s per-family result shape, the inverse of `filer-lookup.ts`'s
 * `FilerLookupFamily`: it carries no `cluster_id`-shaped key and keeps `relationship`
 * per-member because it answers who belongs to this family.
 *
 * `distinct_member_count` is `members` deduped by `node_id`, while `members` itself is
 * never deduped (provenance plurality), so `members.length` over-counts whenever more
 * than one row corroborates the same member; it counts distinct nodes rather than rows,
 * so widening `filer_family`'s primary key cannot inflate it.
 *
 * `display_names` is {@linkcode readFamilyDisplayNames}'s output over this family's current
 * members, and a multi-spelling family (two raw names canonicalizing to the same `family_id`)
 * surfaces every spelling, sorted, rather than picking one.
 */
export interface FamilyRollup {
	family_id: string
	members: FamilyRollupMember[]
	distinct_member_count: number
	display_names: string[]
	as_of: string
	vintage: string
}

/**
 * Read a `familyID`'s rollup at `asOf`, or `null` when no member row is in force at
 * that date (including when the family has never existed).
 */
async function readFamilyRollup(
	db: DatabaseClient<FilerDatabase>,
	familyID: string,
	asOf: string,
	vintage: string
): Promise<FamilyRollup | null> {
	const memberRows = await readFamilyMembers(db, familyID, asOf)

	if (!memberRows.length) {
		return null
	}

	const displayNames = await readFamilyDisplayNames(db, memberRows)

	return {
		family_id: familyID,
		members: memberRows.map((row) => ({
			node_id: row.node_id,
			relationship: row.relationship,
			assertion: row.assertion,
			match_score: row.match_score,
			source: row.source,
		})),
		distinct_member_count: new Set(memberRows.map((row) => row.node_id)).size,
		display_names: displayNames,
		as_of: asOf,
		vintage,
	}
}

/**
 * Read every corporate family a `familyID`/`nodeID` resolves to; a `familyID` query
 * returns at most one element, while a `nodeID` query may return several because a node
 * legitimately belonging to more than one family is a normal shape rather than an error.
 */
export async function familyRollup(
	db: DatabaseClient<FilerDatabase>,
	query: FamilyRollupQuery
): Promise<FamilyRollup[]> {
	const suppliedCount = (query.familyID !== undefined ? 1 : 0) + (query.nodeID !== undefined ? 1 : 0)

	if (suppliedCount !== 1) {
		throw new Error("familyRollup: exactly one of `familyID`, `nodeID` is required")
	}

	// Manifest-first, matching `filerLookup`: this throws before any `filer_family` query runs.
	const manifest = await readFilerManifest(db)

	assertFamilySchemaVersion(manifest.schema_version, "familyRollup")

	const asOf = query.asOf ?? todayISODate()

	if (query.familyID !== undefined) {
		const rollup = await readFamilyRollup(db, query.familyID, asOf, manifest.source_vintage)

		return rollup ? [rollup] : []
	}

	const nodeID = query.nodeID!

	// Never throws on more than one result: a node carrying both a HoldingCompany
	// and a ManagementCompany membership is a normal, builder-emitted shape.
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

		// Not expected to be null — the query above already confirmed an in-force row for
		// this family at this `asOf` — but guarded rather than asserted, because trusting
		// that invariant across two separate queries is a shortcut this design refuses.
		if (rollup) {
			rollups.push(rollup)
		}
	}

	return rollups
}
