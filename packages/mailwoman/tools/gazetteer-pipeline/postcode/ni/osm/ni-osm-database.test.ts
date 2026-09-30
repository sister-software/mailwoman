/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture-scale check for the NI OSM postcode database. The name law holds and the medoid lands on a member point.
 *   A malformed tag value is dropped and reported. The provenance `meta` reaches the sealed artifact.
 *
 *   The fixture is a synthetic Overpass response in the real envelope shape, because a node has `lat`/`lon` and a way has `center`; a parser that handles only one still passes tests written against the other.
 */

import { statPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { type layerschemadatabase, LayerTier, readLayerManifest } from "@mailwoman/core/layers"
import { NI_OSM_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, expect, test } from "vitest"

import { buildPostcodeNIOSM, NI_LIVE_POSTCODES } from "#gazetteer/postcode/ni/osm/database"

let root: TemporaryDirectory
let sourceDir: PathBuilder

function node(id: number, postcode: string, lat: number, lon: number): Record<string, unknown> {
	return { type: "node", id, lat, lon, tags: { "addr:postcode": postcode, "addr:street": "Somewhere Road" } }
}

/**
 * A way element under `out center` stores its coordinate in `center`, the shape
 * a reader that only handles nodes silently drops.
 */
function way(id: number, postcode: string, lat: number, lon: number): Record<string, unknown> {
	return { type: "way", id, center: { lat, lon }, tags: { "addr:postcode": postcode, building: "yes" } }
}

beforeAll(async () => {
	root = await temporaryDirectory("ni-osm-")
	sourceDir = root.path("acquisition")
	await makeDirectories(sourceDir)

	const response = {
		version: 0.6,
		generator: "Overpass API (fixture)",
		osm3s: {
			timestamp_osm_base: "2026-08-05T13:14:01Z",
			copyright: "The data included in this document is from www.openstreetmap.org.",
		},
		elements: [
			// BT3 9QQ across three elements, two of them ways: the medoid must land on one
			// of the three and the mean is deliberately not a member.
			node(1, "BT3 9QQ", 54.6, -5.88),
			way(2, "BT3 9QQ", 54.61, -5.89),
			way(3, "BT3 9QQ", 54.62, -5.9),
			// Lowercase and a doubled inner space normalize to the same code,
			// so these are one postcode with two attestations.
			node(4, "bt1 5gs", 54.597, -5.93),
			node(5, "BT1  5GS", 54.598, -5.931),
			// The malformed value the real acquisition contains exactly one of.
			node(6, "BT36 4RU,", 54.68, -5.95),
			// No coordinate at all, counted rather than assumed away.
			{ type: "relation", id: 7, tags: { "addr:postcode": "BT47 1AA" } },
			// An element with no postcode tag at all, to prove `tagged` is not just `elements`.
			{ type: "node", id: 8, lat: 54.5, lon: -6, tags: { amenity: "bench" } },
		],
	}

	await writeLocalTextFile(`${stringifyJSON(response)}\n`, sourceDir("response.json"))
})

afterAll(() => root[Symbol.asyncDispose]())

test("buildPostcodeNIOSM: #920 laws, the malformed drop, and the ODbL/meaning-of-zero provenance", async () => {
	const out = root.path("ni.db")

	const result = await buildPostcodeNIOSM({
		sourceDir,
		out,
		offline: true,
		now: new Date("2026-08-05T00:00:00.000Z"),
	})

	// Two postcodes survive.
	// The malformed value and the coordinate-less relation are dropped.
	// The untagged node never counts as tagged.
	expect(result.inserted).toBe(2)
	expect(result.stats.elements).toBe(8)
	expect(result.stats.tagged).toBe(7)
	expect(result.stats.points).toBe(5)
	expect(result.stats.skippedMalformed).toBe(1)
	expect(result.stats.skippedNoCoordinate).toBe(1)
	// The reported value identifies which value was dropped; `"BT36 4RU,"` is a typo rather than a bug.
	expect(result.stats.malformedValues).toEqual({ "BT36 4RU,": 1 })
	// Ways are not a footnote: 2 of the 5 surviving points come from `center`.
	expect(result.stats.pointsByType).toEqual({ node: 3, way: 2 })
	expect(result.districts).toBe(2)
	expect(result.sectors).toBe(2)
	expect(result.reconciliationFailures).toEqual([])
	// The data extract's date rather than the wall clock.
	expect(result.osmTimestamp).toBe("2026-08-05T13:14:01Z")
	// Sealed 0444, checked by mode bits rather than accessSync, because a root path ignores the permission.
	expect((await statPath(out)).mode & 0o222).toBe(0)

	using db = new DatabaseClient<WOFDatabase>(out, { readOnly: true })

	// Name law: `spr.name` is the sanitized-query token shape and the display form is an alt `names` row.
	const names = db.prepare("SELECT id, name FROM spr ORDER BY name").all() as Array<{ id: number; name: string }>
	expect(names.map((n) => n.name)).toEqual(["BT15GS", "BT39QQ"])
	// Ids come from this database's own range, a function of the postcode set
	// rather than of the response's element order.
	expect(names.map((n) => n.id)).toEqual([NI_OSM_ID_BASE, NI_OSM_ID_BASE + 1])

	const alt = db.prepare("SELECT COUNT(*) AS n FROM names WHERE name = 'BT3 9QQ'").get() as { n: number }
	expect(alt.n).toBe(1)

	// The spaced form must never be the primary name, or its bigrams partial-match the wrong codes.
	const spaced = db.prepare("SELECT COUNT(*) AS n FROM spr WHERE name LIKE '% %'").get() as { n: number }
	expect(spaced.n).toBe(0)

	const bt1 = db.prepare("SELECT COUNT(*) AS n FROM names WHERE name = 'BT1 5GS'").get() as { n: number }
	expect(bt1.n).toBe(1)

	const typo = db.prepare("SELECT COUNT(*) AS n FROM names WHERE name LIKE 'BT36%'").get() as { n: number }
	expect(typo.n).toBe(0)

	// Medoid law: the centroid is one of the member points, so it always lands on a mapped address.
	const bt3 = db.prepare("SELECT latitude, longitude FROM spr WHERE name='BT39QQ'").get() as {
		latitude: number
		longitude: number
	}

	expect([
		[54.6, -5.88],
		[54.61, -5.89],
		[54.62, -5.9],
	]).toContainEqual([bt3.latitude, bt3.longitude])

	// Every place is searchable and has an ancestors self-row the parent-constraint subquery reads.
	const fts = db.prepare("SELECT COUNT(*) AS n FROM place_search").get() as { n: number }
	expect(fts.n).toBe(2)
	const anc = db.prepare("SELECT COUNT(*) AS n FROM ancestors").get() as { n: number }
	expect(anc.n).toBe(2)

	// Northern Ireland is part of the UK, so the country is GB.
	const country = db.prepare("SELECT DISTINCT country FROM spr").all() as Array<{ country: string }>
	expect(country).toEqual([{ country: "GB" }])

	// The artifact records the licence obligation, tier and coverage as provenance.
	const meta = new Map(
		(db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>).map((r) => [
			r.key,
			r.value,
		])
	)

	expect(meta.get("built_at")).toBe("2026-08-05T00:00:00.000Z")
	expect(meta.get("countries")).toBe("GB")
	expect(meta.get("license")).toContain("ODbL")
	expect(meta.get("attribution")).toContain("OpenStreetMap contributors")
	expect(meta.get("tier")).toBe("build-local")
	expect(meta.get("tier_reason")).toContain("never published")
	// The meaning-of-zero rule is stated in the artifact rather than a runbook that can drift from it.
	expect(meta.get("coverage_meaning_of_zero")).toContain("NOT ATTESTED IN OPENSTREETMAP")
	expect(meta.get("coverage")).toContain(`of ${NI_LIVE_POSTCODES}`)
	expect(meta.get("source_osm_timestamp")).toBe("2026-08-05T13:14:01Z")
	// The query that produced these bytes is recorded, so a rebuild can be compared against it.
	expect(meta.get("source_query")).toContain("addr:postcode")
	expect(meta.get("source_response_md5")).toMatch(/^[0-9a-f]{32}$/)

	const drops = parseJSONStrict<{ malformedValues: Record<string, number> }>(meta.get("quality_drops")!)
	expect(drops.malformedValues).toEqual({ "BT36 4RU,": 1 })

	// The layer manifest states the same tier, the field the candidate build reads.
	using layer = new DatabaseClient<layerschemadatabase>(out, { readOnly: true })

	const manifest = await readLayerManifest(layer)

	expect(manifest.name).toBe("postalcode-ni-osm")
	expect(manifest.tier).toBe(LayerTier.BuildLocal)
	expect(manifest.license).toBe("ODbL-1.0")
	expect(manifest.attribution).toContain("OpenStreetMap contributors")
	expect(manifest.sourceVintage).toBe("2026-08-05T13:14:01Z")
	expect(manifest.spineKeys).toEqual({ wofID: "id" })
})

test("buildPostcodeNIOSM: a response modified since acquisition is refused, not built from", async () => {
	const dir = root.path("tampered")
	await makeDirectories(dir)

	await writeLocalTextFile(`${stringifyJSON({ elements: [node(1, "BT1 5GS", 54.6, -5.93)] })}\n`, dir("response.json"))

	// A sidecar recording a different md5, the shape a half-edited acquisition dir takes.
	await writeLocalJSONFile(
		{ endpoint: "x", query: "y", queryMD5: "z", retrievedAt: "t", bytes: 1, md5: "0".repeat(32) },
		dir("acquisition.json")
	)

	await expect(buildPostcodeNIOSM({ sourceDir: dir, out: root.path("tampered.db"), offline: true })).rejects.toThrow(
		/has been modified since acquisition/
	)
})
