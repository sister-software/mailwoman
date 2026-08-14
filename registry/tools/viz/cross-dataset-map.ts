/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render linked entities from a GeoJSON file in MapLibre, colored by source combination.
 *   `crossAgencyOnly` removes links whose sources belong to one agency.
 */

import { readFileSync, writeFileSync } from "node:fs"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath, tempRootPath } from "@mailwoman/core/utils"
import { toMapHTML } from "@mailwoman/registry"

/**
 * Distinct agencies a combination needs before it is plotted as a cross-agency cluster.
 */
const MIN_DISTINCT_AGENCIES = 3

/**
 * Options for {@linkcode crossDatasetMap}.
 */
export interface CrossDatasetMapOptions {
	/**
	 * The `cross-dataset-links` GeoJSON. Default
	 * `$MAILWOMAN_DATA_ROOT/record-matcher/2026-06-16-cross-dataset-links.geojson`.
	 */
	in?: string
	/**
	 * Output HTML path. Default `/tmp/cross-dataset-map.html`.
	 */
	outHTML?: string
	/**
	 * Keep only entities whose sources span >1 agency (the two FCC datasets count as one).
	 */
	crossAgencyOnly?: boolean
}

const SOURCE_LABELS: Record<string, string> = {
	nppes: "NPPES",
	"fcc-rhc": "FCC RHC",
	"fcc-rhc-commitments": "FCC commitments",
	"txhhsc-nursing": "TX HHSC",
}

const label = (s: string) => SOURCE_LABELS[s] ?? s

/**
 * Which AGENCY each source belongs to. The two FCC datasets (RHC posted-services + commitments) are ONE agency — so an
 * NPPES↔FCC or FCC↔TX link is cross-AGENCY, but an RHC↔commitments link is not. `--cross-agency-only` keeps just the
 * entities whose sources span >1 agency: the harder, more striking "no shared key ACROSS agencies" slice (most of the
 * raw links are FCC-internal).
 */
const SOURCE_AGENCY: Record<string, string> = {
	nppes: "CMS",
	"fcc-rhc": "FCC",
	"fcc-rhc-commitments": "FCC",
	"txhhsc-nursing": "TX HHSC",
}

const agencyOf = (s: string) => SOURCE_AGENCY[s] ?? s

const sourcesOf = (f: { properties: Record<string, unknown> | null }) =>
	Array.isArray(f.properties?.["sources"]) ? (f.properties!["sources"] as string[]) : []

/**
 * Render the cross-dataset-links GeoJSON to a bucket-colored MapLibre HTML page.
 */
export function crossDatasetMap(
	options: CrossDatasetMapOptions = {},
	report?: (line: string) => void
): { outHTML: string; kept: number; total: number; triple: number } {
	const IN = options.in || dataRootPath("record-matcher", "2026-06-16-cross-dataset-links.geojson")
	const OUT = options.outHTML || tempRootPath("cross-dataset-map.html")
	const CROSS_AGENCY_ONLY = options.crossAgencyOnly ?? false

	const parsed = parseJSONStrict<{
		type: "FeatureCollection"
		features: Array<{ properties: Record<string, unknown> | null }>
	}>(readFileSync(IN, "utf8"))

	const total = parsed.features.length

	const geojson = CROSS_AGENCY_ONLY
		? { ...parsed, features: parsed.features.filter((f) => new Set(sourcesOf(f).map(agencyOf)).size > 1) }
		: parsed

	// Synthesize a `bucket` per entity = its sorted source-combination, so toMapHTML colors by the link
	// TYPE (two-source vs the rarer all-three-source spans) rather than the binary cross/single status.
	let triple = 0
	const comboCounts = new Map<string, number>()

	for (const f of geojson.features) {
		const combo = [...new Set(sourcesOf(f))].toSorted()
		const bucket = combo.map(label).join(" + ") || "unlinked"

		if (f.properties) {
			f.properties["bucket"] = bucket
		}

		if (new Set(combo.map(agencyOf)).size >= MIN_DISTINCT_AGENCIES) {
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

	for (const [combo, n] of [...comboCounts.entries()].toSorted((a, b) => b[1] - a[1])) {
		report?.(`    ${n.toString().padStart(4)}  ${combo}`)
	}

	report?.(`  spanning all three agencies: ${triple}`)

	return { outHTML: OUT, kept, total, triple }
}
