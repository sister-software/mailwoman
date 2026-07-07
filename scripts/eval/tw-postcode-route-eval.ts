/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end TW postcode-route eval (#473, the #294/#288-Phase-1 pre-registered gate): sample
 *   held-out Overture TW address points, feed (district text + 3-digit postcode) to the real
 *   backend, and grade the RESOLVED COORDINATE by true point-in-polygon containment.
 *
 *   PIP truth source: WOF admin-tw is point-only (no polygons anywhere in the repo), so containment
 *   is graded against the Overture `divisions` district polygons (368 districts, fetched
 *   release-pinned by `fetch-tw-division-polygons.ts`). Both sides of the metric are geometric:
 *
 *   - GOLD district = the district polygon containing the sampled address point.
 *   - RESOLVED district = the district polygon containing the resolved place's coordinates.
 *   - PIP-PASS = same polygon. A resolved point in no district polygon is a FAIL, not a skip.
 *
 *   City-level containment (the resolved point landing in the right county-level `region` polygon)
 *   is reported separately for the failures — the honest ledger for the ~22 districts WOF has no
 *   row for (the builder maps those to the containing city, coarser but true).
 *
 *   Split note (#473 How-TW step 5): the builder consumes NO Overture address points — its inputs
 *   are the Chunghwa Post table, WOF admin-tw, and the divisions polygons — so every sampled
 *   address point is held-out by construction. The polygon layer is shared between the builder's
 *   bridge and this eval's truth; the address points themselves are disjoint from the build.
 *
 *   The query shape mirrors the JP harness (`jp-resolver-eval.ts`): text = the district name as a
 *   user would write it (from the point's own `address_levels`), placetype `locality`, sibling
 *   postcode, country TW. Backend = the SHIPPED admin-global-priority.db + the new
 *   postcode-locality-tw.db, i.e. the true production attach.
 *
 *   OOM discipline: the 9.7M-row parquet is sampled with a bounded reservoir and read via
 *   stream()+fetchChunk() (the national-situs pattern); DuckDB threads/memory are capped.
 *
 *   Usage: node scripts/eval/tw-postcode-route-eval.ts [--n 3000] [--seed 42]\
 *   [--postcode-db $MAILWOMAN_DATA_ROOT/wof/postcode-locality-tw.db] [--out <report.json>]
 */

import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"
import { dataRootPath } from "@mailwoman/core/utils"
import { WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { geometryContains } from "@mailwoman/resolver-wof-sqlite/geo"

import {
	type DivisionPolygon,
	loadDistrictPolygons,
	loadPostalDistricts,
	normHan,
} from "mailwoman/gazetteer-pipeline/postcode-locality/tw"

const RELEASE = "2026-06-17.0"

const { values } = parseArgs({
	options: {
		n: { type: "string" },
		seed: { type: "string" },
		"postcode-db": { type: "string" },
		"postal-xml": { type: "string" },
		divisions: { type: "string" },
		out: { type: "string" },
	},
})

const N = values.n ? Number.parseInt(values.n, 10) : 3000
const SEED = values.seed ? Number.parseInt(values.seed, 10) : 42
const POSTCODE_DB = values["postcode-db"] ?? dataRootPath("wof", "postcode-locality-tw.db")
const POSTAL_XML = values["postal-xml"] ?? dataRootPath("tw-postal", "district-centroids.xml")
const DIVISIONS = values.divisions ?? path.join(dataRootPath("overture"), RELEASE, "divisions-tw-admin.jsonl")
const PARQUET = path.join(dataRootPath("overture"), RELEASE, "addresses-tw.parquet")

function toRad(deg: number): number {
	return (deg * Math.PI) / 180
}

function haversineKm(aLat: number, bLon: number, cLat: number, dLon: number): number {
	const R = 6371.0
	const dp = toRad(cLat - aLat)
	const dl = toRad(dLon - bLon)

	return (
		2 *
		R *
		Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(cLat)) * Math.sin(dl / 2) ** 2))
	)
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN

	return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))]!
}

/** Simple bbox-prefiltered containment probe over the fetched polygon set. */
function containingPolygon(polygons: DivisionPolygon[], lon: number, lat: number): DivisionPolygon | null {
	for (const p of polygons) {
		const [minLon, minLat, maxLon, maxLat] = p.bbox

		if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue

		if (geometryContains(p.geometry, lon, lat) === true) return p
	}

	return null
}

// ---- Load the reference layers -------------------------------------------------------------

const districtPolygons = loadDistrictPolygons(DIVISIONS)

// Region polygons ride the same JSONL under subtype=region; loadDistrictPolygons filters to
// locality, so re-read the raw lines for the region slice (26 rows — trivial).
const regionPolygons: DivisionPolygon[] = []

for (const line of readFileSync(DIVISIONS, "utf8").split("\n")) {
	if (!line.trim()) continue
	const row = JSON.parse(line) as { subtype: string; name: string; geometry: unknown }

	if (row.subtype !== "region") continue
	const geometry = (typeof row.geometry === "string" ? JSON.parse(row.geometry) : row.geometry) as never
	let minLon = Infinity
	let minLat = Infinity
	let maxLon = -Infinity
	let maxLat = -Infinity
	const scan = (coords: unknown): void => {
		if (Array.isArray(coords) && typeof coords[0] === "number") {
			const [lon, lat] = coords as [number, number]
			minLon = Math.min(minLon, lon)
			maxLon = Math.max(maxLon, lon)
			minLat = Math.min(minLat, lat)
			maxLat = Math.max(maxLat, lat)

			return
		}

		if (Array.isArray(coords)) {
			for (const c of coords) {
				scan(c)
			}
		}
	}
	scan((geometry as { coordinates?: unknown }).coordinates)
	regionPolygons.push({
		name: row.name,
		nameHan: normHan(row.name),
		nameEn: null,
		wikidata: null,
		geometry,
		bbox: [minLon, minLat, maxLon, maxLat],
	})
}

// 行政區名 (normHan'd) → postcode, from the same authoritative postal table the builder keyed on.
const postalByName = new Map<string, string>()

for (const d of loadPostalDistricts(POSTAL_XML)) {
	postalByName.set(normHan(d.name), d.postcode)
}

const backend = new WOFSqlitePlaceLookup({
	databasePath: [dataRootPath("wof", "admin-global-priority.db"), POSTCODE_DB],
})

// ---- Sample the held-out points (stream + fetchChunk; never materialize the scan) ------------

const instance = await DuckDBInstance.create()
const duck = await instance.connect()
await duck.run("SET threads=4;")
await duck.run("SET memory_limit='8GB';")

interface SamplePoint {
	county: string
	district: string
	lat: number
	lon: number
	dataset: string
}

const samples: SamplePoint[] = []
const stream = await duck.stream(`
	SELECT
		address_levels[1].value AS county,
		address_levels[2].value AS district,
		lat, lon,
		sources[1].dataset AS dataset
	FROM read_parquet('${PARQUET}')
	USING SAMPLE reservoir(${N} ROWS) REPEATABLE (${SEED})
`)
const colNames = stream.columnNames()

for (let chunk = await stream.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await stream.fetchChunk()) {
	for (const r of chunk.getRowObjects(colNames) as Array<Record<string, unknown>>) {
		const lat = Number(r.lat)
		const lon = Number(r.lon)

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
		samples.push({
			county: String(r.county ?? ""),
			district: String(r.district ?? ""),
			lat,
			lon,
			dataset: String(r.dataset ?? "unknown"),
		})
	}
}
duck.closeSync()

// ---- Grade ----------------------------------------------------------------------------------

let noGoldPolygon = 0
let noPostcode = 0
let unresolved = 0
let pipPass = 0
let pipFail = 0
let cityPassAmongFail = 0
let levelsAgree = 0
let levelsChecked = 0
const distances: number[] = []
const failByDistrict = new Map<string, number>()

for (const s of samples) {
	const gold = containingPolygon(districtPolygons, s.lon, s.lat)

	if (!gold) {
		noGoldPolygon++
		continue
	}

	// Cross-check the NLSC-attributed levels against the geometric truth (report only).
	levelsChecked++

	if (normHan(s.district) === gold.nameHan) {
		levelsAgree++
	}

	// The postcode a user would attach: keyed from the point's own admin attribution (county +
	// district — what the printed address carries), which is how the postcode reaches a query.
	const pc = postalByName.get(normHan(s.county + s.district)) ?? postalByName.get(normHan(s.county) + gold.nameHan)

	if (!pc) {
		noPostcode++
		continue
	}

	const cands = await backend.findPlace({
		text: s.district,
		placetype: "locality",
		postcode: pc,
		country: "TW",
	} as never)
	const top = cands[0] as { lat?: number; lon?: number; name?: string } | undefined

	if (!top || typeof top.lat !== "number" || typeof top.lon !== "number") {
		unresolved++
		continue
	}

	distances.push(haversineKm(top.lat, top.lon, s.lat, s.lon))
	const resolved = containingPolygon(districtPolygons, top.lon, top.lat)

	if (resolved && resolved.nameHan === gold.nameHan && resolved.name === gold.name) {
		pipPass++
	} else {
		pipFail++
		failByDistrict.set(gold.name, (failByDistrict.get(gold.name) ?? 0) + 1)
		// City-level consolation: right county-level polygon?
		const goldRegion = containingPolygon(regionPolygons, s.lon, s.lat)
		const resolvedRegion = containingPolygon(regionPolygons, top.lon, top.lat)

		if (goldRegion && resolvedRegion && goldRegion.name === resolvedRegion.name) {
			cityPassAmongFail++
		}
	}
}

const graded = pipPass + pipFail
distances.sort((a, b) => a - b)
const p50 = percentile(distances, 0.5)
const p90 = percentile(distances, 0.9)
const pipPct = (100 * pipPass) / graded
const worstDistricts = [...failByDistrict.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)

const report = {
	release: RELEASE,
	n_sampled: samples.length,
	seed: SEED,
	no_gold_polygon: noGoldPolygon,
	no_postcode: noPostcode,
	unresolved,
	graded,
	pip_pass: pipPass,
	pip_pct: Number(pipPct.toFixed(1)),
	city_pass_among_fail: cityPassAmongFail,
	pip_or_city_pct: Number(((100 * (pipPass + cityPassAmongFail)) / graded).toFixed(1)),
	coord_p50_km: Number(p50.toFixed(2)),
	coord_p90_km: Number(p90.toFixed(2)),
	address_levels_agree_pct: Number(((100 * levelsAgree) / levelsChecked).toFixed(1)),
	worst_districts: Object.fromEntries(worstDistricts),
}

console.log(`TW postcode-route eval (text=district + 3-digit postcode), n=${samples.length}:`)
console.log(`  gold polygon found:  ${samples.length - noGoldPolygon} (skipped ${noGoldPolygon} offshore/no-polygon)`)
console.log(`  postcode keyed:      ${graded + unresolved} (skipped ${noPostcode} no-postal-row)`)
console.log(`  resolved:            ${graded} (${unresolved} unresolved)`)
console.log(`  PIP-containment:     ${pipPass}/${graded} (${pipPct.toFixed(1)}%)  [gate: >=~85%]`)
console.log(`  +city-level contain: ${pipPass + cityPassAmongFail}/${graded} (${report.pip_or_city_pct}%)`)
console.log(`  coord p50/p90:       ${p50.toFixed(2)} / ${p90.toFixed(2)} km`)
console.log(`  address_levels agreement with polygon truth: ${report.address_levels_agree_pct}%`)
console.log(`  worst districts: ${worstDistricts.map(([n, c]) => `${n}(${c})`).join(", ")}`)

if (values.out) {
	writeFileSync(values.out, JSON.stringify(report, null, "\t"))
	console.log(`  report -> ${values.out}`)
}
backend.close?.()
process.exit(0)
