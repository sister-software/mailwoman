/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer polygons` — build the crisp-polygon sibling for the demo's map. (The slim
 *   `wof-hot.db` points source is RETIRED 2026-06-20 — the admin tier resolves against the
 *   candidate table now; build polygons with `--admin` below, keyed by the same WOF spr ids the
 *   candidate table returns.) The demo's map draws the WOF RECTANGLE (`place_bbox`) today; this
 *   packs the real admin geometry — simplified — so the demo can draw an actual boundary, loaded
 *   lazily only when a result is shown.
 *
 *   Source: the per-id WOF GeoJSON repos at
 *   `<repos>/whosonfirst-data-admin-<cc>/data/<id-sharded>/<id>.geojson`, where the shard path is
 *   the id split into 3-char chunks (101909779 → 101/909/779/101909779.geojson). Only ADMIN
 *   placetypes carry polygons; postcodes resolve to a point marker, so they're skipped. We pull the
 *   in-scope ids straight from the already-built points/admin DB so the two stay in lockstep.
 *
 *   Each ring is Douglas-Peucker simplified (default tol ~0.004° ≈ 400 m) to keep the file shippable
 *   — admin polygons are huge at full resolution. Output: `polygons(id INTEGER PRIMARY KEY, geom
 *   TEXT)` where geom is a GeoJSON geometry the demo feeds straight into a MapLibre source.
 *
 *   Source modes: `--points <wof-hot.db>` keeps the demo sidecar in lockstep with the slim points DB
 *   (small, shippable). `--admin <admin-global-priority.db>` instead pulls EVERY admin row from the
 *   full gazetteer (optionally `--countries US,DE`) — the broad-coverage build the node-side
 *   reverse geocoder (#484) wants: the slim DB excludes localadmin, which is where US town polygons
 *   actually live (VT: 255/255 localadmin have real polygons, 0 reached the demo sidecar).
 */

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import zod from "zod"

import { commandError, type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const ADMIN_PLACETYPES = new Set(["locality", "localadmin", "region", "county", "borough", "macroregion", "country"])

const OptionsSchema = zod.object({
	points: zod
		.string()
		.optional()
		.describe("Slim points DB (wof-hot.db) — keeps the demo sidecar in lockstep. Mutually exclusive with --admin."),
	admin: zod
		.string()
		.optional()
		.describe("Full gazetteer admin DB (admin-global-priority.db) — broad coverage. Mutually exclusive with --points."),
	countries: zod
		.string()
		.optional()
		.describe("With --admin: comma-separated ISO codes to restrict (e.g. US,DE). Default: all."),
	out: zod.string().optional().describe("Output wof-polygons.db path (required)."),
	tol: zod.coerce
		.number()
		.optional()
		.default(0.004)
		.describe("Douglas-Peucker simplification tolerance in degrees (~0.004° ≈ 400 m)."),
	repos: zod
		.string()
		.optional()
		.default(dataRootPath("wof", "repos", "whosonfirst-data"))
		.describe("Root of the per-country WOF GeoJSON repos (whosonfirst-data-admin-<cc>/...)."),
})

export { OptionsSchema as options }

type Position = number[]
type LinearRing = Position[]

interface SprRow {
	id: number
	country: string
	placetype: string
}

interface RawGeometry {
	type: string
	// Polygon → LinearRing[]; MultiPolygon → LinearRing[][]. Typed loosely at the JSON boundary.
	coordinates: LinearRing[] | LinearRing[][]
}

/** WOF shard path: id split into 3-char chunks, then the full id. */
function geojsonPath(repos: string, country: string, id: number): string {
	const s = String(id)
	const shard = s.match(/.{1,3}/g)!.join("/")

	return `${repos}/whosonfirst-data-admin-${country.toLowerCase()}/data/${shard}/${s}.geojson`
}

/** Perpendicular distance from point p to segment a–b (planar — fine at admin scale). */
function segDist(p: Position, a: Position, b: Position): number {
	const dx = b[0]! - a[0]!
	const dy = b[1]! - a[1]!

	if (dx === 0 && dy === 0) return Math.hypot(p[0]! - a[0]!, p[1]! - a[1]!)
	const t = ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / (dx * dx + dy * dy)
	const tc = Math.max(0, Math.min(1, t))

	return Math.hypot(p[0]! - (a[0]! + tc * dx), p[1]! - (a[1]! + tc * dy))
}

/** Douglas-Peucker on a ring of [lon,lat]. Keeps endpoints; preserves closure. */
function dp(ring: LinearRing, tol: number): LinearRing | null {
	if (ring.length <= 3) return ring
	const keep = new Uint8Array(ring.length)
	keep[0] = keep[ring.length - 1] = 1
	const stack: Array<[number, number]> = [[0, ring.length - 1]]

	while (stack.length) {
		const [lo, hi] = stack.pop()!
		let maxD = -1
		let idx = -1

		for (let i = lo + 1; i < hi; i++) {
			const d = segDist(ring[i]!, ring[lo]!, ring[hi]!)

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
	const out: LinearRing = []

	for (let i = 0; i < ring.length; i++)
		if (keep[i]) {
			out.push(ring[i]!)
		}

	// A degenerate ring (<4 pts after simplify) can't render — drop it by signalling null.
	return out.length >= 4 ? out : null
}

/**
 * Simplify a Polygon / MultiPolygon geometry; drop rings that collapse. Returns null if nothing left.
 */
function simplify(geom: RawGeometry, tol: number): RawGeometry | null {
	const ringSet = (poly: LinearRing[]): LinearRing[] =>
		poly.map((ring) => dp(ring, tol)).filter((r): r is LinearRing => r !== null)

	if (geom.type === "Polygon") {
		const rings = ringSet(geom.coordinates as LinearRing[])

		return rings.length ? { type: "Polygon", coordinates: rings } : null
	}

	if (geom.type === "MultiPolygon") {
		const polys = (geom.coordinates as LinearRing[][]).map((p) => ringSet(p)).filter((rings) => rings.length)

		return polys.length ? { type: "MultiPolygon", coordinates: polys } : null
	}

	return null // Points / lines: no polygon to draw.
}

const GazetteerPolygons: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const out = options.out
		const points = options.points ?? ""
		const admin = options.admin ?? ""

		if (!out) {
			throw commandError(
				"usage: mailwoman gazetteer polygons (--points <wof-hot.db> | --admin <admin.db> [--countries US,DE]) --out <wof-polygons.db> [--tol 0.004]"
			)
		}

		if ((!points && !admin) || (points && admin)) {
			throw commandError("provide exactly one source: --points <wof-hot.db> OR --admin <admin.db>")
		}
		const countries = options.countries
			? options.countries
					.split(",")
					.map((c) => c.trim().toUpperCase())
					.filter(Boolean)
			: null
		const repos = options.repos
		const tol = options.tol

		const srcPath = points || admin
		const src = new DatabaseSync(srcPath, { readOnly: true })
		const where = countries
			? `placetype NOT IN ('postalcode') AND country IN (${countries.map(() => "?").join(",")})`
			: `placetype NOT IN ('postalcode')`
		const rows = (
			src
				.prepare(`SELECT id, country, placetype FROM spr WHERE ${where} ORDER BY id`)
				.all(...(countries ?? [])) as unknown as SprRow[]
		).filter((r) => ADMIN_PLACETYPES.has(r.placetype))
		src.close()

		// Build to a temp sibling, then atomically swap into place (scripts/AGENTS.md: a DB is a
		// readonly artifact — never write the live path in case the build dies halfway). The
		// original .mjs wrote `out` directly; this hardens it without changing the result.
		const tmpOut = `${out}.tmp-${process.pid}`

		for (const stale of [tmpOut, `${tmpOut}-wal`, `${tmpOut}-shm`, `${tmpOut}-journal`]) {
			if (existsSync(stale)) {
				rmSync(stale)
			}
		}

		const dbOut = new DatabaseSync(tmpOut)
		// DDL via the Kysely schema-builder; the hot INSERT loop below stays on the raw `dbOut` handle.
		const kdb = new DatabaseClient({ database: dbOut })
		await kdb.schema
			.createTable("polygons")
			.addColumn("id", "integer", (c) => c.primaryKey())
			.addColumn("geom", "text", (c) => c.notNull())
			.execute()
		const insert = dbOut.prepare(`INSERT OR IGNORE INTO polygons (id, geom) VALUES (?, ?)`)

		let done = 0
		let missing = 0
		let dropped = 0
		dbOut.exec("BEGIN")

		for (const r of rows) {
			const path = geojsonPath(repos, r.country, r.id)

			if (!existsSync(path)) {
				missing++
				continue
			}

			try {
				const feat = JSON.parse(readFileSync(path, "utf8")) as { geometry?: RawGeometry }
				const simp = feat.geometry ? simplify(feat.geometry, tol) : null

				if (!simp) {
					dropped++
					continue
				}
				insert.run(r.id, JSON.stringify(simp))
				done++
			} catch {
				dropped++
			}

			if ((done + missing + dropped) % 2000 === 0) {
				console.error(`  …${done} packed, ${missing} missing, ${dropped} dropped`)
			}
		}
		dbOut.exec("COMMIT")
		dbOut.exec("VACUUM")
		const bytes = dbOut.prepare(`SELECT count(*) n, sum(length(geom)) b FROM polygons`).get() as {
			n: number
			b: number | null
		}
		await kdb.destroy() // closes the underlying `dbOut` handle

		// Atomic swap: move the previous DB aside, slide the new one into place, drop the backup.
		const backup = `${out}.old-${process.pid}`

		if (existsSync(out)) {
			renameSync(out, backup)
		}
		renameSync(tmpOut, out)

		if (existsSync(backup)) {
			rmSync(backup)
		}

		const mb = Math.round((bytes.b || 0) / 1024 / 1024)

		return [`${out}: ${done} polygons`, `${missing} no-geometry, ${dropped} dropped, ~${mb} MB geom`]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null // progress streams to stderr until the summary lands
}

export default GazetteerPolygons
