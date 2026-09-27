/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The admin gazetteer's `layer_manifest` — phase 3 of the lab-reproducibility sequence.
 *
 *   `mailwoman data inventory` measured the gap this closes: 10 of 210 databases in the data root carry a
 *   manifest, and `wof/` — 79 databases, 74 GB, read by every geocode — carried none. The interface already
 *   existed (`docs/engineering/reference/layer-interface.mdx`); it had simply never been rolled out past
 *   `poi.db` and four OSM databases.
 *
 *   derived from the RUN rather than from the recipe. `source` is composed from the rows each fold actually
 *   ingested, so a build that reads no Overture rows does not claim Overture as a source. That is the
 *   #1015 lesson in its narrowest form: the manifest that lagged did so because it recorded an intention,
 *   and the real recipe had to be reconstructed from the artifact's synthetic-id ranges afterwards.
 *
 *   The license is a conjunction and the manifest says so. Three sources with three different terms fold
 *   into one file, so there is no single license for the result. The field carries an SPDX-style `AND`
 *   expression naming exactly the folds that contributed. Recording the most permissive of them, or the
 *   license of the largest contributor, would be a distribution claim nobody made.
 *
 *   Each term is the fold's publisher's own grant, read from that publisher's text rather than assigned
 *   here. Until 2026-09-27 two of the three were assigned: Who's On First read `ODbL-1.0`, a grant its
 *   license text does not state, and Overture Divisions read `CDLA-Permissive-2.0`, which is the Places
 *   theme's grant rather than Divisions'. The expression happened to carry share-alike and reached it
 *   through the wrong fold, so a reader tracing the obligation arrived at the wrong document.
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
 * `sourceVintage` is deliberately absent here.
 * WOF's vintage is a git commit per cloned repo, Overture's is a release tag,
 * GeoNames' is a dump date — three different kinds of thing, and inventing one shared
 * format for them would record a precision none of them has.
 *
 * The caller passes what it knows.
 */
const SOURCE_TERMS = {
	// Who's On First states CC0 over "the format and structure", in those words, and that the records
	// are a modification of 102 open-data sources carrying their own terms, some requiring attribution.
	// It states no single grant over the records.
	// `LicenseRef-WhosOnFirst-Mixed` records that rather than electing one of the 102,
	// and `refusalsForPublication` refuses it as an identifier with no recorded obligations,
	// which is the correct answer for a grant nobody has read per source.
	// The archived text is `packages/corpus/data/licenses/whosonfirst-licenses.md`.
	wof: { name: "whosonfirst", license: "LicenseRef-WhosOnFirst-Mixed" },
	// Overture licenses per theme, and its attribution page gives Divisions `License for theme: ODbL`.
	// This read `CDLA-Permissive-2.0`, which is the Places theme's grant, so the expression
	// named the wrong license for the one fold whose publisher does state share-alike.
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
	 * What each contributing source was AT.
	 *
	 * Keys that no source contributed are ignored.
	 * A contributing source with no recorded vintage is reported as `unknown` rather than omitted,
	 * because a vintage nobody captured is a fact about the build and not a field to leave blank.
	 */
	vintages?: Partial<Record<keyof IngestCounts, string>>
	createdAt: string
	version: string
}

/**
 * Compose the admin gazetteer's manifest.
 *
 * @throws When no source contributed.
 * A gazetteer built from no source is not a layer with an empty manifest.
 * It is a failed build, and recording a manifest for it would make the artifact look describable.
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
		// Never `shipped`.
		// Overture's Divisions theme is ODbL, which is share-alike, and the Who's On First
		// records carry 102 sources' terms that nobody has read per source.
		// Either one is enough.
		// The builder ships and the artifact is built locally.
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
		// and GeoNames folds, and the join key every consumer uses either way.
		spineKeys: { wofID: "id" },
		createdAt: input.createdAt,
	}
}
