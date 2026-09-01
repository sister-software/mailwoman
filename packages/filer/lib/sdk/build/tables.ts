/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The table set `buildFilerDatabase` writes into, created in one pass before any row is staged.
 *
 *   Table DDL goes through Kysely's schema builder while the row writes stay on raw prepared statements against the
 *   SAME `DatabaseSync` handle — the house split between modelled schema and the hot bulk-write path.
 *   `filer_cluster` and `filer_family` are created EMPTY here for schema completeness: `cluster-filers.ts`
 *   populates the former in a later build pass, `build-filer.ts`'s own family-membership emission the latter.
 */

import type { Kysely } from "kysely"

import {
	createFilerAttributeTable,
	createFilerClusterTable,
	createFilerEdgeTable,
	createFilerFamilyTable,
	createFilerManifestTable,
	createFilerNodeTable,
	type FilerDatabase,
} from "#schema"

/**
 * Create the build-only `filer_attribute_stage` table — see `build-filer.ts`'s module docstring for why `value` is part
 * of the composite PK. Deliberately NOT part of the public {@link FilerDatabase} interface, mirroring `build-bdc.ts`'s
 * `bdc_stage` (dropped before the artifact seals). All reads/writes against it go through raw `.prepare()` on the
 * shared `DatabaseSync`, per the "hot bulk write" carve-out.
 */
async function createFilerAttributeStageTable(db: Kysely<FilerDatabase>): Promise<void> {
	await db.schema
		.createTable("filer_attribute_stage")
		.addColumn("node_id", "text", (c) => c.notNull())
		.addColumn("key", "text", (c) => c.notNull())
		.addColumn("value", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("source_vintage", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("filer_attribute_stage_pk", ["node_id", "key", "value", "source", "source_vintage"])
		.execute()
}

/**
 * Create every table this builder writes to, in one place. Separate from `buildFilerDatabase` so that function stays
 * under the linter's `max-statements` ceiling — inlining these calls at its single call site would behave identically.
 */
export async function createFilerBuildTables(kdb: Kysely<FilerDatabase>): Promise<void> {
	await createFilerManifestTable(kdb)
	await createFilerNodeTable(kdb)
	await createFilerEdgeTable(kdb)
	await createFilerAttributeTable(kdb)
	await createFilerClusterTable(kdb)
	await createFilerFamilyTable(kdb)
	await createFilerAttributeStageTable(kdb)
}
