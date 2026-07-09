/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The cross-dataset linking map — the marquee record-matcher proof, on a map.
 *
 *   The matcher resolves entities ACROSS independent sources (NPPES provider registry, FCC RHC
 *   funding, TX HHSC facility licensing) with NO shared key — purely on the geocoded location +
 *   name agreement. This renders the `cross-dataset-links` GeoJSON (every entity that resolved
 *   across ≥2 sources) on the HOUSE map stack via {@link toMapHTML} (MapLibre GL + a Protomaps
 *   basemap). Each entity is colored by its SOURCE COMBINATION (a synthesized `bucket`), so the
 *   entities spanning all three sources stand out from the two-source links.
 *
 *   Neutral entity-resolution view: it shows what resolved to what and how confidently (cohesion
 *   sizes the marker). It does NOT interpret coverage/eligibility — that is the consumer's call.
 *
 *   SERVE THE OUTPUT OVER LOCALHOST (the house tile server CORS-restricts to localhost + the docs
 *   domains; a file:// page shows accurate markers on a blank basemap). e.g. `python3 -m
 *   http.server -d <dir>` then open the page; or use `renderServedMapToPNG` (`./render-map.ts`)
 *   against the served URL.
 *
 *   `--cross-agency-only` keeps just the entities whose sources span >1 AGENCY (the two FCC datasets
 *   count as one) — the harder cross-agency slice; most raw links are FCC-internal (RHC ↔
 *   commitments).
 *
 *   Run: `mailwoman registry viz cross-dataset-map [--in <links.geojson>]
 *   [--out-html /tmp/cross-dataset-map.html] [--cross-agency-only]`
 */

import { readFileSync, writeFileSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"
import { toMapHTML } from "@mailwoman/registry"

/** Options for {@linkcode crossDatasetMap}. */
export interface CrossDatasetMapOptions {
	/**
	 * The `cross-dataset-links` GeoJSON. Default
	 * `$MAILWOMAN_DATA_ROOT/record-matcher/2026-06-16-cross-dataset-links.geojson`.
	 */
	in?: string
	/** Output HTML path. Default `/tmp/cross-dataset-map.html`. */
	outHtml?: string
	/** Keep only entities whose sources span >1 agency (the two FCC datasets count as one). */
	crossAgencyOnly?: boolean
}

const SOURCE_LABELS: Record<string, string> = {
	nppes: "NPPES",
	"fcc-rhc": "FCC RHC",
	"fcc-rhc-commitments": "FCC commitments",
	"txhhsc-nursing": "TX HHSC",
}
const label = (s: string) => SOURCE_LABELS[s] ?? s

// Which AGENCY each source belongs to. The two FCC datasets (RHC posted-services + commitments) are
// ONE agency — so an NPPES↔FCC or FCC↔TX link is cross-AGENCY, but an RHC↔commitments link is not.
// `--cross-agency-only` keeps just the entities whose sources span >1 agency: the harder, more
// striking "no shared key ACROSS agencies" slice (most of the raw links are FCC-internal).
const SOURCE_AGENCY: Record<string, string> = {
	nppes: "CMS",
	"fcc-rhc": "FCC",
	"fcc-rhc-commitments": "FCC",
	"txhhsc-nursing": "TX HHSC",
}
const agencyOf = (s: string) => SOURCE_AGENCY[s] ?? s

const sourcesOf = (f: { properties: Record<string, unknown> | null }) =>
	Array.isArray(f.properties?.["sources"]) ? (f.properties!["sources"] as string[]) : []

/** Render the cross-dataset-links GeoJSON to a bucket-colored MapLibre HTML page. */
export function crossDatasetMap(
	options: CrossDatasetMapOptions = {},
	report?: (line: string) => void
): { outHtml: string; kept: number; total: number; triple: number } {
	const IN = options.in || dataRootPath("record-matcher", "2026-06-16-cross-dataset-links.geojson")
	const OUT = options.outHtml || "/tmp/cross-dataset-map.html"
	const CROSS_AGENCY_ONLY = options.crossAgencyOnly ?? false

	const parsed = JSON.parse(readFileSync(IN, "utf8")) as {
		type: "FeatureCollection"
		features: Array<{ properties: Record<string, unknown> | null }>
	}
	const total = parsed.features.length
	const geojson = CROSS_AGENCY_ONLY
		? { ...parsed, features: parsed.features.filter((f) => new Set(sourcesOf(f).map(agencyOf)).size > 1) }
		: parsed

	// Synthesize a `bucket` per entity = its sorted source-combination, so toMapHTML colors by the link
	// TYPE (two-source vs the rarer all-three-source spans) rather than the binary cross/single status.
	let triple = 0
	const comboCounts = new Map<string, number>()

	for (const f of geojson.features) {
		const combo = [...new Set(sourcesOf(f))].sort()
		const bucket = combo.map(label).join(" + ") || "unlinked"

		if (f.properties) {
			f.properties["bucket"] = bucket
		}

		if (new Set(combo.map(agencyOf)).size >= 3) {
			triple++
		}
		comboCounts.set(bucket, (comboCounts.get(bucket) ?? 0) + 1)
	}

	const kept = geojson.features.length
	const scope = CROSS_AGENCY_ONLY ? "across agencies" : "across sources"
	const html = toMapHTML(geojson as never, {
		title: `Cross-dataset entity links — ${kept} resolved ${scope} (no shared key)`,
		flavor: "light",
		colorBy: "bucket",
	})

	writeFileSync(OUT, html)
	report?.(`[written] ${OUT}  (${kept}${CROSS_AGENCY_ONLY ? ` of ${total} cross-AGENCY` : ""} entities)`)
	report?.(`  source combinations:`)

	for (const [combo, n] of [...comboCounts.entries()].sort((a, b) => b[1] - a[1])) {
		report?.(`    ${n.toString().padStart(4)}  ${combo}`)
	}
	report?.(`  spanning all three agencies: ${triple}`)

	return { outHtml: OUT, kept, total, triple }
}
