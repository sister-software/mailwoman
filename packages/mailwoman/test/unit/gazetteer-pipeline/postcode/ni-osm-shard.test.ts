/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture-scale guard for the NI OSM postcode shard. The real gate is the full build's reconciliation
 *   against the 2026-08-05 census (12,327 elements → 4,757 units → exactly 1 malformed value); this
 *   holds the four things that gate cannot express cheaply — the #920 name law survives, the medoid
 *   lands on a real member point, a malformed tag value is DROPPED and named rather than repaired, and
 *   the provenance `meta` reaches the sealed artifact carrying the ODbL obligation and the
 *   meaning-of-zero coverage record.
 *
 *   The fixture is a synthetic Overpass response written in the real envelope shape (`osm3s` + a mixed
 *   node/way/relation `elements` list), because the shapes are what the reader has to get right: a node
 *   carries `lat`/`lon` and a way carries `center`, and a parser that handles only one of them still
 *   passes every test written against the other.
 */

import { statPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { join } from "@mailwoman/platform/path"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import {
	buildPostcodeNIOSM,
	NI_LIVE_POSTCODES,
	NI_OSM_ID_BASE,
} from "mailwoman/gazetteer-pipeline/postcode/ni-osm-shard"
import { afterAll, beforeAll, expect, test } from "vitest"

let root: TemporaryDirectory
let sourceDir: string

/**
 * A node element — carries its coordinate directly.
 */
function node(id: number, postcode: string, lat: number, lon: number): Record<string, unknown> {
	return { type: "node", id, lat, lon, tags: { "addr:postcode": postcode, "addr:street": "Somewhere Road" } }
}

/**
 * A way element under `out center` — carries its coordinate as `center`, which is the shape a reader that only handles
 * nodes silently drops.
 */
function way(id: number, postcode: string, lat: number, lon: number): Record<string, unknown> {
	return { type: "way", id, center: { lat, lon }, tags: { "addr:postcode": postcode, building: "yes" } }
}

beforeAll(async () => {
	root = await temporaryDirectory("ni-osm-")
	sourceDir = root.resolve("acquisition")
	await makeDirectories(sourceDir)

	const response = {
		version: 0.6,
		generator: "Overpass API (fixture)",
		osm3s: {
			timestamp_osm_base: "2026-08-05T13:14:01Z",
			copyright: "The data included in this document is from www.openstreetmap.org.",
		},
		elements: [
			// BT3 9QQ across three elements, two of them ways — the medoid must land ON one of the three,
			// and the mean (54.6100, -5.8900) is deliberately not a member.
			node(1, "BT3 9QQ", 54.6, -5.88),
			way(2, "BT3 9QQ", 54.61, -5.89),
			way(3, "BT3 9QQ", 54.62, -5.9),
			// Lowercase + a doubled inner space: both normalize to the same single-space uppercase code, so
			// this is ONE postcode with two attestations, not two codes and a typo.
			node(4, "bt1 5gs", 54.597, -5.93),
			node(5, "BT1  5GS", 54.598, -5.931),
			// The malformed value the real acquisition contains exactly one of.
			node(6, "BT36 4RU,", 54.68, -5.95),
			// No coordinate at all — a shape Overpass should not return, counted rather than assumed away.
			{ type: "relation", id: 7, tags: { "addr:postcode": "BT47 1AA" } },
			// An element with no postcode tag at all, to prove `tagged` is not just `elements`.
			{ type: "node", id: 8, lat: 54.5, lon: -6, tags: { amenity: "bench" } },
		],
	}

	await writeLocalTextFile(`${JSON.stringify(response)}\n`, join(sourceDir, "response.json"))
})

afterAll(() => root[Symbol.asyncDispose]())

test("buildPostcodeNIOSM: #920 laws, the malformed drop, and the ODbL/meaning-of-zero provenance", async () => {
	const out = root.resolve("ni.db")

	const result = await buildPostcodeNIOSM({
		sourceDir,
		out,
		offline: true,
		now: new Date("2026-08-05T00:00:00.000Z"),
	})

	// Two postcodes survive: BT3 9QQ (3 attestations) and BT1 5GS (2). The malformed value and the
	// coordinate-less relation are dropped, and the untagged node never counts as tagged at all.
	expect(result.inserted).toBe(2)
	expect(result.stats.elements).toBe(8)
	expect(result.stats.tagged).toBe(7)
	expect(result.stats.points).toBe(5)
	expect(result.stats.skippedMalformed).toBe(1)
	expect(result.stats.skippedNoCoordinate).toBe(1)
	// A drop counter says something broke; the named value says WHAT. `"BT36 4RU,"` is a typo, not a bug.
	expect(result.stats.malformedValues).toEqual({ "BT36 4RU,": 1 })
	// Ways and relations are not a footnote — 2 of the 5 surviving points come from `center`.
	expect(result.stats.pointsByType).toEqual({ node: 3, way: 2 })
	expect(result.districts).toBe(2)
	expect(result.sectors).toBe(2)
	// Every internal identity holds; nothing is silently unaccounted for.
	expect(result.reconciliationFailures).toEqual([])
	// The data cut, not the wall clock — the date that actually describes the rows.
	expect(result.osmTimestamp).toBe("2026-08-05T13:14:01Z")
	// Sealed 0444 — the artifact is read-only from the moment it exists (mode bits, not accessSync: root.path
	// ignores the permission and would pass a W_OK probe on a sealed file).
	expect((await statPath(out)).mode & 0o222).toBe(0)

	await using db = new DatabaseClient<WOFDatabase>(out, { readOnly: true })

	// Name law: `spr.name` is the sanitized-query token shape; the display form is an alt `names` row.
	const names = db.prepare("SELECT id, name FROM spr ORDER BY name").all() as Array<{ id: number; name: string }>
	expect(names.map((n) => n.name)).toEqual(["BT15GS", "BT39QQ"])
	// Ids come from this shard's own range, and sorting by name makes them a function of the postcode set
	// rather than of the response's element order.
	expect(names.map((n) => n.id)).toEqual([NI_OSM_ID_BASE, NI_OSM_ID_BASE + 1])

	const alt = db.prepare("SELECT COUNT(*) AS n FROM names WHERE name = 'BT3 9QQ'").get() as { n: number }
	expect(alt.n).toBe(1)

	// The spaced form must never be the primary name — the CZ build that stored it measured WORSE than no
	// coverage at all (#920), because its bigrams partial-matched the wrong codes.
	const spaced = db.prepare("SELECT COUNT(*) AS n FROM spr WHERE name LIKE '% %'").get() as { n: number }
	expect(spaced.n).toBe(0)

	// Case folding: the lowercase and double-spaced tags collapsed into ONE place, not two plus a typo.
	const bt1 = db.prepare("SELECT COUNT(*) AS n FROM names WHERE name = 'BT1 5GS'").get() as { n: number }
	expect(bt1.n).toBe(1)

	// The malformed value reached neither table.
	const typo = db.prepare("SELECT COUNT(*) AS n FROM names WHERE name LIKE 'BT36%'").get() as { n: number }
	expect(typo.n).toBe(0)

	// Medoid law: the centroid is one of the three member points — here 54.61/-5.89, the member nearest the
	// (54.6100, -5.8900) mean. A mean-of-members build would store a coordinate on no mapped address.
	const bt3 = db.prepare("SELECT latitude, longitude FROM spr WHERE name='BT39QQ'").get() as {
		latitude: number
		longitude: number
	}

	expect([
		[54.6, -5.88],
		[54.61, -5.89],
		[54.62, -5.9],
	]).toContainEqual([bt3.latitude, bt3.longitude])

	// Every place is searchable and has an ancestors self-row (the parent-constraint subquery reads it).
	const fts = db.prepare("SELECT COUNT(*) AS n FROM place_search").get() as { n: number }
	expect(fts.n).toBe(2)
	const anc = db.prepare("SELECT COUNT(*) AS n FROM ancestors").get() as { n: number }
	expect(anc.n).toBe(2)

	// Northern Ireland is part of the UK, so the country is GB — the value postcode shard routing keys on.
	const country = db.prepare("SELECT DISTINCT country FROM spr").all() as Array<{ country: string }>
	expect(country).toEqual([{ country: "GB" }])

	// Provenance travels IN the artifact: the licence obligation, the tier, and the honest coverage record.
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
	// The meaning-of-zero rule, stated in the artifact rather than in a runbook that can drift from it.
	expect(meta.get("coverage_meaning_of_zero")).toContain("NOT ATTESTED IN OPENSTREETMAP")
	expect(meta.get("coverage")).toContain(`of ${NI_LIVE_POSTCODES}`)
	expect(meta.get("source_osm_timestamp")).toBe("2026-08-05T13:14:01Z")
	// The query that produced THESE bytes is recorded, so a rebuild can be compared against it.
	expect(meta.get("source_query")).toContain("addr:postcode")
	expect(meta.get("source_response_md5")).toMatch(/^[0-9a-f]{32}$/)

	const drops = parseJSONStrict<{ malformedValues: Record<string, number> }>(meta.get("quality_drops")!)
	expect(drops.malformedValues).toEqual({ "BT36 4RU,": 1 })
})

test("buildPostcodeNIOSM: a response modified since acquisition is refused, not built from", async () => {
	const dir = root.resolve("tampered")
	await makeDirectories(dir)

	await writeLocalTextFile(
		`${JSON.stringify({ elements: [node(1, "BT1 5GS", 54.6, -5.93)] })}\n`,
		join(dir, "response.json")
	)

	// A sidecar recording a DIFFERENT md5 — the shape a half-edited acquisition dir takes.
	await writeLocalJSONFile(
		{ endpoint: "x", query: "y", queryMD5: "z", retrievedAt: "t", bytes: 1, md5: "0".repeat(32) },
		join(dir, "acquisition.json")
	)

	await expect(buildPostcodeNIOSM({ sourceDir: dir, out: root.resolve("tampered.db"), offline: true })).rejects.toThrow(
		/has been modified since acquisition/
	)
})
