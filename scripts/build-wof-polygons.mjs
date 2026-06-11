#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the crisp-polygon sibling of the demo points DB (`wof-hot.db`, built by the geojson-free
 *   `build-slim` / `mailwoman-wof-build-slim`). The demo's map draws the WOF bounding RECTANGLE
 *   (`place_bbox`) today; this packs the real admin geometry — simplified — so the demo can draw an
 *   actual boundary, loaded lazily only when a result is shown.
 *
 *   Source: the per-id WOF GeoJSON repos at
 *   `repos/whosonfirst-data/whosonfirst-data-admin-<cc>/data/<id-sharded>/<id>.geojson`, where the
 *   shard path is the id split into 3-char chunks (101909779 → 101/909/779/101909779.geojson). Only
 *   ADMIN placetypes carry polygons; postcodes resolve to a point marker, so they're skipped. We
 *   pull the in-scope ids straight from the already-built points DB so the two stay in lockstep.
 *
 *   Each ring is Douglas-Peucker simplified (default tol ~0.004° ≈ 400 m) to keep the file shippable
 *   — admin polygons are huge at full resolution. Output: `polygons(id INTEGER PRIMARY KEY, geom
 *   TEXT)` where geom is a GeoJSON geometry the demo feeds straight into a MapLibre source.
 *
 *   Usage: node scripts/build-wof-polygons.mjs --points <wof-hot.db> --out <wof-polygons.db> [--tol
 *   0.004]
 *
 *   Source modes: `--points <wof-hot.db>` keeps the demo sidecar in lockstep with the slim points
 *   DB (small, shippable). `--admin <admin-global-priority.db>` instead pulls EVERY admin row from
 *   the full gazetteer (optionally `--countries US,DE`) — the broad-coverage build the node-side
 *   reverse geocoder (#484) wants: the slim DB excludes localadmin, which is where US town
 *   polygons actually live (VT: 255/255 localadmin have real polygons, 0 reached the demo sidecar).
 */

import { existsSync, readFileSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

const REPOS = "/mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data"
const ADMIN_PLACETYPES = new Set(["locality", "localadmin", "region", "county", "borough", "macroregion", "country"])

function parseArgs() {
	const a = process.argv.slice(2)
	const o = { points: "", admin: "", countries: null, output: "", tol: 0.004 }
	for (let i = 0; i < a.length; i++) {
		if (a[i] === "--points") o.points = a[++i]
		else if (a[i] === "--admin") o.admin = a[++i]
		else if (a[i] === "--countries") o.countries = a[++i].split(",").map((c) => c.trim().toUpperCase())
		else if (a[i] === "--out") o.output = a[++i]
		else if (a[i] === "--tol") o.tol = parseFloat(a[++i])
	}
	if ((!o.points && !o.admin) || (o.points && o.admin) || !o.output) {
		console.error(
			"usage: build-wof-polygons.mjs (--points <wof-hot.db> | --admin <admin.db> [--countries US,DE]) --out <wof-polygons.db> [--tol 0.004]"
		)
		process.exit(2)
	}
	return o
}

/** WOF shard path: id split into 3-char chunks, then the full id. */
function geojsonPath(country, id) {
	const s = String(id)
	const shard = s.match(/.{1,3}/g).join("/")
	return `${REPOS}/whosonfirst-data-admin-${country.toLowerCase()}/data/${shard}/${s}.geojson`
}

/** Perpendicular distance from point p to segment a–b (planar — fine at admin scale). */
function segDist(p, a, b) {
	const dx = b[0] - a[0]
	const dy = b[1] - a[1]
	if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
	const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
	const tc = Math.max(0, Math.min(1, t))
	return Math.hypot(p[0] - (a[0] + tc * dx), p[1] - (a[1] + tc * dy))
}

/** Douglas-Peucker on a ring of [lon,lat]. Keeps endpoints; preserves closure. */
function dp(ring, tol) {
	if (ring.length <= 3) return ring
	const keep = new Uint8Array(ring.length)
	keep[0] = keep[ring.length - 1] = 1
	const stack = [[0, ring.length - 1]]
	while (stack.length) {
		const [lo, hi] = stack.pop()
		let maxD = -1
		let idx = -1
		for (let i = lo + 1; i < hi; i++) {
			const d = segDist(ring[i], ring[lo], ring[hi])
			if (d > maxD) {
				maxD = d
				idx = i
			}
		}
		if (maxD > tol && idx > 0) {
			keep[idx] = 1
			stack.push([lo, idx], [idx, hi])
		}
	}
	const out = []
	for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i])
	// A degenerate ring (<4 pts after simplify) can't render — drop it by signalling null.
	return out.length >= 4 ? out : null
}

/**
 * Simplify a Polygon / MultiPolygon geometry; drop rings that collapse. Returns null if nothing
 * left.
 */
function simplify(geom, tol) {
	const ringSet = (poly) => poly.map((ring) => dp(ring, tol)).filter(Boolean)
	if (geom.type === "Polygon") {
		const rings = ringSet(geom.coordinates)
		return rings.length ? { type: "Polygon", coordinates: rings } : null
	}
	if (geom.type === "MultiPolygon") {
		const polys = geom.coordinates.map((p) => ringSet(p)).filter((rings) => rings.length)
		return polys.length ? { type: "MultiPolygon", coordinates: polys } : null
	}
	return null // Points / lines: no polygon to draw.
}

const opts = parseArgs()
if (existsSync(opts.output)) rmSync(opts.output)

const src = new DatabaseSync(opts.points || opts.admin, { readOnly: true })
const where = opts.countries
	? `placetype NOT IN ('postalcode') AND country IN (${opts.countries.map(() => "?").join(",")})`
	: `placetype NOT IN ('postalcode')`
const rows = src
	.prepare(`SELECT id, country, placetype FROM spr WHERE ${where} ORDER BY id`)
	.all(...(opts.countries ?? []))
	.filter((r) => ADMIN_PLACETYPES.has(r.placetype))
src.close()

const out = new DatabaseSync(opts.output)
out.exec(`CREATE TABLE polygons (id INTEGER PRIMARY KEY, geom TEXT NOT NULL);`)
const insert = out.prepare(`INSERT OR IGNORE INTO polygons (id, geom) VALUES (?, ?)`)

let done = 0
let missing = 0
let dropped = 0
out.exec("BEGIN")
for (const r of rows) {
	const path = geojsonPath(r.country, r.id)
	if (!existsSync(path)) {
		missing++
		continue
	}
	try {
		const feat = JSON.parse(readFileSync(path, "utf8"))
		const simp = feat.geometry ? simplify(feat.geometry, opts.tol) : null
		if (!simp) {
			dropped++
			continue
		}
		insert.run(r.id, JSON.stringify(simp))
		done++
	} catch {
		dropped++
	}
	if ((done + missing + dropped) % 2000 === 0)
		console.error(`  …${done} packed, ${missing} missing, ${dropped} dropped`)
}
out.exec("COMMIT")
out.exec("VACUUM")
const bytes = out.prepare(`SELECT count(*) n, sum(length(geom)) b FROM polygons`).get()
out.close()
console.error(
	`✓ ${opts.output}: ${done} polygons (${missing} no-geometry, ${dropped} dropped), ~${Math.round((bytes.b || 0) / 1024 / 1024)} MB geom`
)
