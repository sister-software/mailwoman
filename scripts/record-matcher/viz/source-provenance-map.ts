/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The address-point provenance map — the "show your work" proof, on a map.
 *
 *   Every coordinate Mailwoman resolves to comes from an open dataset, and we keep the provenance
 *   on the point. This samples the per-state address-point DB (`address_point.source`) and renders
 *   it on the house MapLibre + Protomaps stack via {@link toMapHTML}, each dot COLORED BY its
 *   upstream open-data source — the National Address Database (a federal release) vs OpenAddresses
 *   (county / municipal open-data publishers). New York is the clean example: NAD blankets the
 *   state, and New York City arrives separately from NYC Open Data, so the source split is visible
 *   as a geography.
 *
 *   No competitor in this space will tell you which open dataset a given coordinate came from —
 *   for them the assembled pipeline is the moat. Here the provenance is the point of the map.
 *
 *   Streets without a rooftop point are covered by TIGER interpolation (`tiger:edges`), a separate
 *   layer not plotted here; this map is the rooftop-point sources only.
 *
 *   SERVE THE OUTPUT OVER LOCALHOST (the house tile server CORS-restricts to localhost + the docs
 *   domains). e.g. `python3 -m http.server -d <dir>`, or `render-map.mjs` against the served URL.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/viz/source-provenance-map.ts\
 *   [--state ny] [--db <address-points-us-XX.db>] [--out-html /tmp/source-provenance.html]\
 *   [--nad-mod 700] [--oa-mod 120] [--cap 7000]
 */

import { toMapHTML } from "@mailwoman/registry"
import { DatabaseSync } from "node:sqlite"
import { writeFileSync } from "node:fs"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const STATE = arg("state", "ny").toLowerCase()
const DB = arg("db", `/mnt/playpen/mailwoman-data/address-points/address-points-us-${STATE}.db`)
const OUT = arg("out-html", "/tmp/source-provenance.html")
const NAD_MOD = Number(arg("nad-mod", "700")) // keep ~1/700 of NAD points
const OA_MOD = Number(arg("oa-mod", "120")) // keep ~1/120 of OpenAddresses points
const CAP = Number(arg("cap", "7000")) // per-source marker cap

// Collapse the raw `source` string into a human, mappable category. The address-point DB stores e.g.
// "overture:NAD" or "overture:OpenAddresses/NY/NYC Open Data" — the suffix is the real upstream
// publisher, which is what we want to color by (the "overture:" prefix is just the theme it arrived in).
function categorize(source: string): { bucket: string; publisher: string } {
	if (source === "overture:NAD") return { bucket: "National Address Database", publisher: "NAD (federal)" }
	if (source.startsWith("overture:OpenAddresses")) {
		const publisher = source.split("/").slice(-1)[0] || "OpenAddresses"
		return { bucket: "OpenAddresses", publisher: `OpenAddresses · ${publisher}` }
	}
	return { bucket: source, publisher: source }
}

const db = new DatabaseSync(DB, { readOnly: true })

type Row = { lat: number; lon: number; source: string; number: string | null; street_raw: string | null }

// Two stratified samples so the smaller source (OpenAddresses, ~1/6 of NY) stays visible next to NAD.
// abs(random()) % mod == 0 keeps a spatially-uniform ~1/mod fraction; LIMIT caps the marker count.
const sample = (where: string, mod: number): Row[] =>
	db
		.prepare(
			`SELECT lat, lon, source, number, street_raw FROM address_point
			 WHERE ${where} AND lat IS NOT NULL AND lon IS NOT NULL AND abs(random()) % ${mod} = 0
			 LIMIT ${CAP}`,
		)
		.all() as Row[]

const rows = [...sample("source = 'overture:NAD'", NAD_MOD), ...sample("source LIKE 'overture:OpenAddresses%'", OA_MOD)]
db.close()

const counts = new Map<string, number>()
const features = rows.map((r) => {
	const { bucket, publisher } = categorize(r.source)
	counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
	const addr = [r.number, r.street_raw].filter(Boolean).join(" ").trim()
	return {
		type: "Feature" as const,
		geometry: { type: "Point" as const, coordinates: [r.lon, r.lat] },
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

const geojson = { type: "FeatureCollection" as const, features }
const html = toMapHTML(geojson as never, {
	title: `Address-point provenance — ${STATE.toUpperCase()}, every point colored by its open-data source`,
	flavor: "light",
	colorBy: "bucket",
})

writeFileSync(OUT, html)
console.error(`[written] ${OUT}  (${features.length} points)`)
for (const [bucket, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]))
	console.error(`  ${n.toString().padStart(5)}  ${bucket}`)
