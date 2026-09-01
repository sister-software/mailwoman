/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Sample `address_point.source` rows from a state database and render them by source in MapLibre.
 *   The output requires an HTTP origin because the tile server does not serve `file:` origins.
 */

import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { isPresent } from "@mailwoman/core/objects"
import { dataRootPath, tempRootPath } from "@mailwoman/core/utils"
import type { AddressPointDatabase } from "@mailwoman/resolver-wof-sqlite/address"
import type { GeoFeature, GeoFeatureCollection, PointLiteral } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { type MapFeatureData, toMapHTML } from "#index"

/**
 * Options for {@linkcode sourceProvenanceMap}.
 */
export interface SourceProvenanceMapOptions {
	/**
	 * State (lowercase postal). Default ny.
	 */
	state?: string
	/**
	 * Address-point DB path. Default `$MAILWOMAN_DATA_ROOT/address-points/address-points-us-<state>.db`.
	 */
	db?: string
	/**
	 * Output HTML path. Default `/tmp/source-provenance.html`.
	 */
	outHTML?: string
	/**
	 * Keep ~1/N of NAD points. Default 700.
	 */
	nadMod?: number
	/**
	 * Keep ~1/N of OpenAddresses points. Default 120.
	 */
	oaMod?: number
	/**
	 * Per-source marker cap. Default 7000.
	 */
	cap?: number
}

// Collapse the raw `source` string into a human, mappable category. The address-point DB stores e.g.
// "overture:NAD" or "overture:OpenAddresses/NY/NYC Open Data" — the suffix is the real upstream
// publisher, which is what we want to color by (the "overture:" prefix is just the theme it arrived in).
function categorize(source: string): { bucket: string; publisher: string } {
	if (source === "overture:NAD") return { bucket: "National Address Database", publisher: "NAD (federal)" }

	if (source.startsWith("overture:OpenAddresses")) {
		const publisher = source.split("/").at(-1) || "OpenAddresses"

		return { bucket: "OpenAddresses", publisher: `OpenAddresses · ${publisher}` }
	}

	return { bucket: source, publisher: source }
}

// Must stay a type alias. Rows come back from the driver as `Record<string, SQLOutputValue>[]` and
// are asserted to `Row[]`; an object type alias carries an implicit index signature that makes that
// assertion legal, an interface does not.
// oxlint-disable-next-line typescript/consistent-type-definitions -- needs the implicit index signature
type Row = { lat: number; lon: number; source: string; number: string | null; street_raw: string | null }

/**
 * Render the per-state address-point provenance map — see the module doc.
 */
export async function sourceProvenanceMap(
	options: SourceProvenanceMapOptions = {},
	report?: (line: string) => void
): Promise<{ outHTML: string; points: number }> {
	const STATE = (options.state || "ny").toLowerCase()
	const DB = options.db || String(dataRootPath("address-points", `address-points-us-${STATE}.db`))
	const OUT = options.outHTML || tempRootPath("source-provenance.html")
	const NAD_MOD = options.nadMod ?? 700 // keep ~1/700 of NAD points
	const OA_MOD = options.oaMod ?? 120 // keep ~1/120 of OpenAddresses points
	const CAP = options.cap ?? 7000 // per-source marker cap

	using db = new DatabaseClient<AddressPointDatabase>(DB, { readOnly: true })

	// Two stratified samples so the smaller source (OpenAddresses, ~1/6 of NY) stays visible next to NAD.
	// abs(random()) % mod == 0 keeps a spatially-uniform ~1/mod fraction; LIMIT caps the marker count.
	const sample = (where: string, mod: number): Row[] =>
		db
			.prepare(
				`SELECT lat, lon, source, number, street_raw FROM address_point
			 WHERE ${where} AND lat IS NOT NULL AND lon IS NOT NULL AND abs(random()) % ${mod} = 0
			 LIMIT ${CAP}`
			)
			.all() as Row[]

	const rows = [
		...sample("source = 'overture:NAD'", NAD_MOD),
		...sample("source LIKE 'overture:OpenAddresses%'", OA_MOD),
	]

	const counts = new Map<string, number>()

	const features: GeoFeature<PointLiteral, MapFeatureData>[] = rows.map((r) => {
		const { bucket, publisher } = categorize(r.source)
		counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
		const addr = [r.number, r.street_raw].filter(isPresent).join(" ").trim()

		return {
			type: "Feature",
			geometry: { type: "Point", coordinates: [r.lon, r.lat] },
			properties: {
				bucket,
				sources: [bucket],
				recordCount: 1,
				geocodeTier: "address_point",
				organization: publisher,
				address: addr || null,
			},
		}
	})

	const geojson: GeoFeatureCollection<PointLiteral, MapFeatureData> = { type: "FeatureCollection", features }

	const html = toMapHTML(geojson, {
		title: `Address-point provenance — ${STATE.toUpperCase()}, every point colored by its open-data source`,
		flavor: "light",
		colorBy: "bucket",
	})

	await writeLocalFile(html, OUT)
	report?.(`[written] ${OUT}  (${features.length} points)`)

	for (const [bucket, n] of [...counts.entries()].toSorted((a, b) => b[1] - a[1])) {
		report?.(`  ${n.toString().padStart(5)}  ${bucket}`)
	}

	return { outHTML: OUT, points: features.length }
}
