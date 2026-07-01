/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the reverse geocoder (#484): the ray-cast PIP primitives, the bbox→PIP→descent walk
 *   over an inline fixture gazetteer, and an env-gated integration pass against the REAL production
 *   DBs.
 *
 *   The integration suite SKIPS unless BOTH env vars point at real artifacts (so CI stays green
 *   without them — same pattern as `resolver-wof-wasm/hot-db.test.ts`):
 *
 *   - `MAILWOMAN_WOF_ADMIN_DB` — the admin gazetteer with the package-built `place_bbox` R*Tree, e.g.
 *       `/mnt/playpen/mailwoman-data/wof/admin-global-priority.db`.
 *   - `MAILWOMAN_WOF_POLYGONS_DB` — the polygon sidecar, e.g.
 *       `/tmp/v440-stage/en-us/v4.4.0/wof-polygons.db` (staged by build-demo-assets).
 */

import { DatabaseSync } from "node:sqlite"

import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { geometryContains, pointInPolygonRings, pointInRing, type GeojsonPosition } from "./geo.js"
import { WOFReverseGeocoder } from "./reverse.js"

const square = (minX: number, minY: number, maxX: number, maxY: number): GeojsonPosition[] => [
	[minX, minY],
	[maxX, minY],
	[maxX, maxY],
	[minX, maxY],
	[minX, minY],
]

describe("point-in-polygon primitives", () => {
	test("pointInRing — inside / outside a square", () => {
		const ring = square(0, 0, 10, 10)
		expect(pointInRing(5, 5, ring)).toBe(true)
		expect(pointInRing(15, 5, ring)).toBe(false)
		expect(pointInRing(-1, -1, ring)).toBe(false)
	})

	test("pointInPolygonRings — a hole excludes, an island within the hole includes again", () => {
		const rings = [square(0, 0, 10, 10), square(4, 4, 6, 6)]
		expect(pointInPolygonRings(2, 2, rings)).toBe(true) // solid part
		expect(pointInPolygonRings(5, 5, rings)).toBe(false) // inside the hole
		// Even-odd: an island ring nested inside the hole flips back to inside.
		expect(pointInPolygonRings(5, 5, [...rings, square(4.8, 4.8, 5.2, 5.2)])).toBe(true)
	})

	test("geometryContains — Polygon, MultiPolygon, and non-areal geometry", () => {
		const polygon = { type: "Polygon", coordinates: [square(0, 0, 10, 10)] }
		const multi = {
			type: "MultiPolygon",
			coordinates: [[square(0, 0, 1, 1)], [square(8, 8, 9, 9)]],
		}
		expect(geometryContains(polygon, 5, 5)).toBe(true)
		expect(geometryContains(polygon, 11, 5)).toBe(false)
		expect(geometryContains(multi, 8.5, 8.5)).toBe(true)
		expect(geometryContains(multi, 5, 5)).toBe(false)
		expect(geometryContains({ type: "Point", coordinates: [5, 5] }, 5, 5)).toBeNull()
		expect(geometryContains(null, 5, 5)).toBeNull()
	})
})

/**
 * Fixture gazetteer — a miniature Vermont-like geography around (44.0, -72.0):
 *
 * Country US (1) ⊃ region (2) ⊃ county A (3, polygon) + county B (6, bbox overlaps A but polygon rejects — the
 * bbox-false-positive case) ⊃ localadmin town (4, point geometry, centroid near the query point) ⊃ locality village (5,
 * point geometry, degenerate bbox — reachable only via the ancestors-table descent, never via the R*Tree).
 */
function buildFixture(): { admin: DatabaseSync; polygons: DatabaseSync } {
	const admin = new DatabaseSync(":memory:")
	admin.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		CREATE VIRTUAL TABLE place_bbox USING rtree(id, min_lat, max_lat, min_lon, max_lon);

		INSERT INTO spr VALUES (1, -1, 'United States', 'country', 'US', 39.0, -98.0, 18.0, 72.0, -180.0, -66.0, 1, 0);
		INSERT INTO spr VALUES (2, 1, 'Vermont', 'region', 'US', 44.0, -72.6, 42.7, 45.0, -73.5, -71.4, 1, 0);
		INSERT INTO spr VALUES (3, 2, 'Washington County', 'county', 'US', 44.05, -72.1, 43.8, 44.3, -72.5, -71.8, 1, 0);
		INSERT INTO spr VALUES (4, 3, 'Middlewich', 'localadmin', 'US', 44.01, -72.02, 44.01, 44.01, -72.02, -72.02, 1, 0);
		INSERT INTO spr VALUES (5, 4, 'Middlewich Village', 'locality', 'US', 43.99, -71.98, 43.99, 43.99, -71.98, -71.98, 1, 0);
		-- County B: bbox overlaps the query point but its polygon excludes it (bbox false positive).
		INSERT INTO spr VALUES (6, 2, 'Orange County', 'county', 'US', 43.9, -72.3, 43.85, 44.25, -72.45, -71.85, 1, 0);
		-- A far locality under county A — must NOT be picked (beyond maxApproximateKm).
		INSERT INTO spr VALUES (7, 3, 'Fartown', 'locality', 'US', 44.29, -72.49, 44.29, 44.29, -72.49, -72.49, 1, 0);

		INSERT INTO ancestors VALUES
			(2, 1, 'country'),
			(3, 2, 'region'), (3, 1, 'country'),
			(4, 3, 'county'), (4, 2, 'region'), (4, 1, 'country'),
			(5, 4, 'localadmin'), (5, 3, 'county'), (5, 2, 'region'), (5, 1, 'country'),
			(6, 2, 'region'), (6, 1, 'country'),
			(7, 3, 'county'), (7, 2, 'region'), (7, 1, 'country');

		-- R*Tree mirrors spr min/max for the POLYGONAL places only (the real build skips degenerate
		-- bboxes implicitly: a point bbox can only ever match its exact coordinate).
		INSERT INTO place_bbox VALUES (1, 18.0, 72.0, -180.0, -66.0);
		INSERT INTO place_bbox VALUES (2, 42.7, 45.0, -73.5, -71.4);
		INSERT INTO place_bbox VALUES (3, 43.8, 44.3, -72.5, -71.8);
		INSERT INTO place_bbox VALUES (6, 43.85, 44.25, -72.45, -71.85);
	`)

	const polygons = new DatabaseSync(":memory:")
	polygons.exec(`CREATE TABLE polygons (id INTEGER PRIMARY KEY, geom TEXT NOT NULL);`)
	const insert = polygons.prepare(`INSERT INTO polygons (id, geom) VALUES (?, ?)`)
	// Region polygon: the whole fixture area.
	insert.run(2, JSON.stringify({ type: "Polygon", coordinates: [square(-73.5, 42.7, -71.4, 45.0)] }))
	// County A polygon CONTAINS the query point (44.0, -72.0)…
	insert.run(3, JSON.stringify({ type: "Polygon", coordinates: [square(-72.5, 43.8, -71.8, 44.3)] }))
	// …county B's polygon does NOT (its bbox row lies — DP-simplified bboxes overlap).
	insert.run(6, JSON.stringify({ type: "Polygon", coordinates: [square(-72.45, 43.85, -71.85, 43.95)] }))

	return { admin, polygons }
}

describe("WOFReverseGeocoder over the fixture gazetteer", () => {
	test("PIP confirms the deepest polygon, then descends to the nearest point-geometry child", async () => {
		const { admin, polygons } = buildFixture()
		const rg = new WOFReverseGeocoder({ adminDatabase: admin, polygonDatabase: polygons })
		const result = await rg.reverseGeocode(44.0, -72.0)

		// Deepest = the locality village (descent: county A → town → village), approximate.
		expect(result.containment).toBe("approximate")
		expect(result.hierarchy.map((p) => p.name)).toEqual([
			"Middlewich Village",
			"Middlewich",
			"Washington County",
			"Vermont",
			"United States",
		])
		// The bbox false positive (county B) must never appear.
		expect(result.hierarchy.some((p) => p.id === 6)).toBe(false)
		// The approximate winner carries its centroid distance.
		expect(result.hierarchy[0]?.distanceKm).toBeGreaterThan(0)
		rg.close()
	})

	test("polygon containment is reported when the deepest place IS polygon-confirmed", async () => {
		const { admin, polygons } = buildFixture()
		const rg = new WOFReverseGeocoder({ adminDatabase: admin, polygonDatabase: polygons })
		// Restrict to the polygon-bearing tiers — the deepest is then county A, PIP-confirmed.
		const result = await rg.reverseGeocode(44.0, -72.0, { placetypes: ["country", "region", "county"] })
		expect(result.containment).toBe("polygon")
		expect(result.hierarchy[0]).toMatchObject({ id: 3, placetype: "county" })
		rg.close()
	})

	test("no polygon DB → centroid-only mode, every result approximate", async () => {
		const { admin } = buildFixture()
		const rg = new WOFReverseGeocoder({ adminDatabase: admin })
		const result = await rg.reverseGeocode(44.0, -72.0)
		expect(result.containment).toBe("approximate")
		// Bbox false positives can't be vetoed without polygons; the smallest containing bbox
		// (a county) still anchors the walk and the descent still reaches the village.
		expect(result.hierarchy[0]?.name).toBe("Middlewich Village")
		rg.close()
	})

	test("a point outside every bbox returns an empty hierarchy", async () => {
		const { admin, polygons } = buildFixture()
		const rg = new WOFReverseGeocoder({ adminDatabase: admin, polygonDatabase: polygons })
		const result = await rg.reverseGeocode(-44.0, 72.0)
		expect(result.hierarchy).toEqual([])
		expect(result.containment).toBe("approximate")
		rg.close()
	})

	test("approximate steps respect maxApproximateKm", async () => {
		const { admin, polygons } = buildFixture()
		const rg = new WOFReverseGeocoder({ adminDatabase: admin, polygonDatabase: polygons })
		// Tiny cap: the town centroid (~2 km away) is out of reach → walk stops at county A.
		const result = await rg.reverseGeocode(44.0, -72.0, { maxApproximateKm: 0.5 })
		expect(result.hierarchy[0]).toMatchObject({ id: 3, placetype: "county" })
		expect(result.containment).toBe("polygon")
		rg.close()
	})

	test("rejects out-of-range coordinates", async () => {
		const { admin } = buildFixture()
		const rg = new WOFReverseGeocoder({ adminDatabase: admin })
		await expect(rg.reverseGeocode(91, 0)).rejects.toThrow(RangeError)
		await expect(rg.reverseGeocode(0, 181)).rejects.toThrow(RangeError)
		rg.close()
	})
})

// --- env-gated integration against the real artifacts (see file header for paths) ---------------

const ADMIN_DB = process.env.MAILWOMAN_WOF_ADMIN_DB
const POLYGONS_DB = process.env.MAILWOMAN_WOF_POLYGONS_DB

describe.skipIf(!ADMIN_DB || !POLYGONS_DB)(
	"against the production gazetteer (MAILWOMAN_WOF_ADMIN_DB + MAILWOMAN_WOF_POLYGONS_DB)",
	() => {
		// Construct in beforeAll, not the describe body — the body runs at collection time even when
		// the suite is skipped, and would try to open the (absent) DBs.
		let rg: WOFReverseGeocoder
		beforeAll(() => {
			rg = new WOFReverseGeocoder({ adminDbPath: ADMIN_DB!, polygonDbPath: POLYGONS_DB! })
		})
		afterAll(() => rg?.close())

		test("South Side Chicago → full chain down to the neighbourhood grain", async () => {
			const result = await rg.reverseGeocode(41.8004427, -87.6031768)
			const names = result.hierarchy.map((p) => p.name)
			expect(names).toContain("Chicago")
			expect(names).toContain("Illinois")
			expect(names).toContain("United States")
			// The deepest node is a point-geometry neighbourhood (Hyde Park) → approximate by honest
			// convention, even though the Chicago locality above it is polygon-confirmed.
			expect(result.hierarchy[0]?.placetype).toBe("neighbourhood")
			expect(result.containment).toBe("approximate")
		})

		test("same point, locality-and-coarser only → polygon-confirmed Chicago", async () => {
			const result = await rg.reverseGeocode(41.8004427, -87.6031768, {
				placetypes: ["country", "region", "county", "localadmin", "locality"],
			})
			expect(result.hierarchy[0]).toMatchObject({ name: "Chicago", placetype: "locality" })
			expect(result.containment).toBe("polygon")
		})

		test("Montpelier VT (point-geometry locality) → approximate, region still polygon-anchored", async () => {
			const result = await rg.reverseGeocode(44.2601, -72.5754)
			const names = result.hierarchy.map((p) => p.name)
			expect(names).toContain("Vermont")
			const deepest = result.hierarchy[0]
			expect(["locality", "localadmin", "neighbourhood"]).toContain(deepest?.placetype)
		})

		test("middle of the North Atlantic → empty hierarchy", async () => {
			const result = await rg.reverseGeocode(40.0, -40.0)
			expect(result.hierarchy).toEqual([])
		})
	}
)
