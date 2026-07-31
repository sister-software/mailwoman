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
 *   Given a `familyID`, this returns every member row in force `asOf` the query date. Given a `nodeID`, it
 *   first resolves which family (if any) that node belongs to as of that date, then returns the same
 *   membership rollup — but a node CAN legitimately belong to more than one family at once (Task 2's own
 *   fixtures: a filer whose holding company differs from its management company gets two DIFFERENT family
 *   memberships). Rather than silently pick one, `familyRollup` throws in that case, naming every family
 *   found, because there is no documented rule (unlike decision 6's primary-FRN pick, which
 *   `filerLookup.ts`'s `pickPrimaryFRN` implements) for choosing among them — inventing one here would be
 *   exactly the kind of guess this crosswalk's design refuses to make. Callers who already know which
 *   family they want should query by `familyID` directly.
 *
 *   Manifest-first, same as `filerLookup`: `readFilerManifest` runs before any `filer_family` query, so this
 *   reader never answers with a made-up or missing `vintage`. `asOf` defaults to today via
 *   {@linkcode todayISODate}, imported from `filer-lookup.ts` rather than redefined here, so every reader in
 *   this SDK shares one definition of "today."
 *
 *   Temporal scoping copies `filer-lookup.ts`'s exact half-open predicate verbatim — `valid_from <= asOf AND
 *   (valid_to IS NULL OR valid_to > asOf)` — rather than reimplementing it: three separate 3a tasks fixed
 *   this same class of bug independently before the final review caught them diverging, and the task brief
 *   for this module names that history explicitly as the reason to copy, not rewrite.
 */

import type { DatabaseClient } from "@mailwoman/core/kysley/client"

import { readFilerManifest, type FilerDatabase } from "../schema.ts"
import { todayISODate } from "./filer-lookup.ts"

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
 * {@linkcode familyRollup}'s result shape — a corporate family's full membership, `asOf`-scoped. Deliberately carries
 * no `cluster_id`-shaped key and no single top-level `relationship` (unlike {@link FilerLookupFamily} in
 * `filer-lookup.ts`, which answers "which families does ONE node belong to"): this is the inverse view, "who belongs to
 * THIS family," so `relationship` lives per-member instead.
 */
export interface FamilyRollup {
	family_id: string
	members: FamilyRollupMember[]
	as_of: string
	vintage: string
}

/**
 * Read a corporate family's membership — see the module docstring for the full contract (XOR query, manifest-first,
 * temporal scoping, the nodeID-ambiguity refusal). Returns `null` when the resolved `familyID` has no member row in
 * force `asOf` the query date (including when it has never existed at all, or when queried by a `nodeID` that belongs
 * to no family as of that date).
 */
export async function familyRollup(
	db: DatabaseClient<FilerDatabase>,
	query: FamilyRollupQuery
): Promise<FamilyRollup | null> {
	const suppliedCount = (query.familyID !== undefined ? 1 : 0) + (query.nodeID !== undefined ? 1 : 0)

	if (suppliedCount !== 1) {
		throw new Error("familyRollup: exactly one of `familyID`, `nodeID` is required")
	}

	// Manifest-first (matches filerLookup's discipline) — throws before any filer_family query runs at all.
	const manifest = await readFilerManifest(db)

	const asOf = query.asOf ?? todayISODate()

	let familyID = query.familyID

	if (familyID === undefined) {
		const nodeID = query.nodeID!

		// Resolve which family (or families) this node belongs to as of asOf — same half-open predicate as every
		// other temporal read in this module.
		const nodeFamilyRows = await db
			.selectFrom("filer_family")
			.select("family_id")
			.where("node_id", "=", nodeID)
			.where("valid_from", "<=", asOf)
			.where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
			.execute()

		const distinctFamilyIDs = [...new Set(nodeFamilyRows.map((row) => row.family_id))]

		if (!distinctFamilyIDs.length) {
			return null
		}

		if (distinctFamilyIDs.length > 1) {
			throw new Error(
				`familyRollup: node_id ${JSON.stringify(nodeID)} belongs to ${distinctFamilyIDs.length} distinct ` +
					`families as of ${asOf} (${distinctFamilyIDs.join(", ")}) — there is no documented rule for picking ` +
					"one, so this refuses to guess. Query by familyID directly to disambiguate."
			)
		}

		familyID = distinctFamilyIDs[0]!
	}

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
		as_of: asOf,
		vintage: manifest.source_vintage,
	}
}
