/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The admin gazetteer's `layer_manifest`.
 *
 *   Derived from the run rather than from the recipe: `source` is composed from the rows each fold
 *   actually ingested, so a build that reads no Overture rows does not claim Overture as a source.
 *
 *   The license is a conjunction: three sources with three different terms fold into one file, so the
 *   field contains an SPDX-style `AND` expression naming exactly the contributing folds. Each term is
 *   the publisher's own grant read from that publisher's text.
 */

import type { LayerManifest } from "@mailwoman/core/layers"
import { LayerFreshnessPolicy, LayerTier } from "@mailwoman/core/layers"

/**
 * How many rows each fold contributed to a build.
 */
export interface IngestCounts {
	wof: number
	overture: number
	geonames: number
}

/**
 * Per-source identity: the name that goes in `source`, and the licence its rows arrive under.
 *
 * `sourceVintage` is deliberately absent here: WOF's is a git commit per cloned repo,
 * Overture's identity is a release tag.
 * GeoNames' identity is a dump date.
 *
 * One shared format would record precision that none of the sources provides.
 */
const SOURCE_TERMS = {
	// Who's On First states CC0 over "the format and structure", in those words.
	// Its records are a modification of 102 open-data sources carrying their own terms,
	// some requiring attribution.
	// It states no single grant over the records, so `LicenseRef-WhosOnFirst-Mixed`
	// records that rather than electing one of the 102.
	wof: { name: "whosonfirst", license: "LicenseRef-WhosOnFirst-Mixed" },
	// Overture licenses each theme.
	// Its attribution page gives Divisions `License for theme: ODbL`.
	overture: { name: "overture-divisions", license: "ODbL-1.0" },
	geonames: { name: "geonames", license: "CC-BY-4.0" },
} as const satisfies Record<keyof IngestCounts, { name: string; license: string }>

/**
 * The folds that actually contributed rows, in a fixed order so two builds with
 * the same sources produce the same string.
 */
function contributingSources(counts: IngestCounts): Array<keyof IngestCounts> {
	return (["wof", "overture", "geonames"] as const).filter((key) => counts[key] > 0)
}

export interface AdminManifestInput {
	counts: IngestCounts
	/**
	 * The git sha of the tree that ran the build.
	 */
	buildSHA: string
	/**
	 * What each contributing source was at.
	 *
	 * Keys no source contributed are ignored.
	 * A contributing source with no recorded vintage is reported as `unknown` rather than omitted.
	 */
	vintages?: Partial<Record<keyof IngestCounts, string>>
	createdAt: string
	version: string
}

/**
 * Compose the admin gazetteer's manifest.
 *
 * @throws When no source contributed — a gazetteer built from no source is a failed build,
 * so it cannot ship as a layer with an empty manifest.
 */
export function adminLayerManifest(input: AdminManifestInput): LayerManifest {
	const contributing = contributingSources(input.counts)

	if (!contributing.length) {
		throw new Error(
			"adminLayerManifest: no source ingested any rows — refusing to stamp a manifest on an empty gazetteer"
		)
	}

	return {
		name: "admin-global-priority",
		version: input.version,
		schemaVersion: 1,
		// Never `shipped`: Overture's Divisions theme is share-alike ODbL and the Who's On First records
		// terms for 102 sources without per-source review, either one enough to keep the artifact local.
		tier: LayerTier.BuildLocal,
		license: contributing.map((key) => SOURCE_TERMS[key].license).join(" AND "),
		attribution: contributing.map((key) => SOURCE_TERMS[key].name).join(", "),
		source: contributing.map((key) => SOURCE_TERMS[key].name).join("+"),
		sourceVintage: contributing
			.map((key) => `${SOURCE_TERMS[key].name}=${input.vintages?.[key] ?? "unknown"}`)
			.join(" "),
		buildCmd: "mailwoman gazetteer build admin",
		buildSHA: input.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		// `spr.id` is the WOF id — real for WOF rows, synthetic for the Overture
		// and GeoNames folds — and the join key every consumer uses either way.
		spineKeys: { wofID: "id" },
		createdAt: input.createdAt,
	}
}
