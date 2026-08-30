/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The candidate gazetteer's `layer_manifest` — the artifact every geocode actually reads.
 *
 *   THE CANDIDATE IS DERIVED, so its manifest names its INPUT rather than restating the input's sources.
 *   `buildCandidateTable` reads an admin gazetteer plus postcode and locality shards; it ingests nothing
 *   from WOF, Overture or GeoNames directly. A manifest that repeated "whosonfirst+overture+geonames" here
 *   would be true of the ancestor and unfalsifiable of this file — it could not tell you WHICH admin build
 *   this came from, which is the only question a reproduction actually asks.
 *
 *   So the source is the ancestor's identity, read out of the ancestor's own manifest when it has one:
 *   `admin-global-priority@2026-08-17.0`. That makes provenance a CHAIN, and a chain is what survives the
 *   thing the flat form cannot — the lab holds thirteen candidate builds and about ten admin builds, and
 *   which pairs with which is currently recorded nowhere.
 *
 *   AN UNPROVENANCED ANCESTOR IS REPORTED, NOT HIDDEN. Every admin build that predates phase 3 has no
 *   manifest, so the chain terminates in `unknown` and says so. Substituting the file's name would look
 *   like provenance and carry none.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { LayerFreshnessPolicy, type LayerManifest, LayerTier } from "@mailwoman/core/layers"
import type { LayerContractDatabase } from "@mailwoman/core/layers/schema"
import { getRow } from "@mailwoman/core/utils"
import { DatabaseClient } from "@mailwoman/sqlite/client"

/**
 * The ancestor's identity as this manifest records it.
 *
 * `unknown` is a measured state — the admin build had no manifest — and is deliberately distinguishable from an admin
 * build whose manifest says its version is literally unknown.
 */
export async function ancestorIdentity(adminDBPath: string): Promise<string> {
	if (!(await pathExists(adminDBPath))) return "unknown (admin gazetteer not found)"

	let db: DatabaseClient<LayerContractDatabase> | undefined

	try {
		db = new DatabaseClient<LayerContractDatabase>(adminDBPath, { readOnly: true })

		const present = db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'layer_manifest' LIMIT 1")
			.get()

		if (!present) return "unknown (admin gazetteer predates the layer contract)"

		const row = getRow<{ name: string; version: string }>(
			db.prepare("SELECT name, version FROM layer_manifest LIMIT 1")
		)

		return row ? `${row.name}@${row.version}` : "unknown (admin manifest is empty)"
	} catch (error) {
		return `unknown (${(error as Error).message})`
	} finally {
		db?.destroy()
	}
}

export interface CandidateManifestInput {
	/**
	 * The admin gazetteer this candidate was built from. Read for its manifest, never for its rows.
	 */
	adminDBPath: string
	/**
	 * How many postcode and locality shards contributed. Recorded because a candidate built with no shards is a different
	 * artifact from one built with twenty-four, and nothing else in the file says which it is.
	 */
	shardCounts: { postcodes: number; localities: number }
	/**
	 * Whether an importance database was folded in. A candidate without it ranks differently, and the difference is
	 * invisible from the schema.
	 */
	importance: boolean
	buildSHA: string
	version: string
	createdAt: string
}

/**
 * Compose the candidate gazetteer's manifest.
 */
export async function candidateLayerManifest(input: CandidateManifestInput): Promise<LayerManifest> {
	const ancestor = await ancestorIdentity(input.adminDBPath)

	return {
		name: "candidate",
		version: input.version,
		schemaVersion: 1,
		// Inherited from the ancestor's terms, not re-derived: the candidate carries the admin gazetteer's rows,
		// so it carries the admin gazetteer's obligations. ODbL is share-alike either way.
		tier: LayerTier.BuildLocal,
		license: "ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0",
		attribution: "derived from the mailwoman admin gazetteer; see that layer's manifest for source terms",
		source: ancestor,
		sourceVintage:
			`admin=${ancestor} postcode-shards=${input.shardCounts.postcodes} ` +
			`locality-shards=${input.shardCounts.localities} importance=${input.importance ? "yes" : "no"}`,
		buildCmd: "mailwoman gazetteer build candidate",
		buildSHA: input.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		// `spr_id` is the join back to the admin gazetteer, and the reason a chained manifest is worth having:
		// the id only means something against a KNOWN ancestor.
		spineKeys: { wofID: "spr_id" },
		createdAt: input.createdAt,
	}
}
