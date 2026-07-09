/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the #1042 street-centroid tier: the shared `stripArrondissement` folder and the
 *   `StreetCentroidSqliteLookup` reader. Seeds a temp-file `street_centroid` fixture (the schema the
 *   `ban/scripts/build-street-centroid-shard.ts` roll-up writes) and asserts postcode-scope probing,
 *   base-commune probing, arrondissement folding, the cross-row WEIGHTED centroid aggregate, the
 *   extent-derived uncertainty, and the exact-match miss.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type StreetCentroidDatabase, createStreetCentroidTable } from "./street-centroid-schema.ts"
import { StreetCentroidSqliteLookup } from "./street-centroid.ts"
import { stripArrondissement } from "./street-normalize.ts"

interface Seed {
	street_norm: string
	postcode: string | null
	locality_base: string
	lat: number
	lon: number
	min_lat: number
	max_lat: number
	min_lon: number
	max_lon: number
	point_count: number
}

/** Seed a temp-file `street_centroid` shard and return its path (the reader opens by path, read-only). */
async function seedShard(rows: Seed[]): Promise<string> {
	const path = join(mkdtempSync(join(tmpdir(), "sc-test-")), "street-centroids.db")
	const db = new DatabaseSync(path)
	const kdb = new DatabaseClient<StreetCentroidDatabase>({ database: db })
	await createStreetCentroidTable(kdb)
	const ins = db.prepare(
		`INSERT INTO street_centroid
		 (street_norm, postcode, locality_base, lat, lon, min_lat, max_lat, min_lon, max_lon, point_count, street_raw, source, release)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ban:fr', '2026-05-18')`
	)

	for (const r of rows) {
		ins.run(
			r.street_norm,
			r.postcode,
			r.locality_base,
			r.lat,
			r.lon,
			r.min_lat,
			r.max_lat,
			r.min_lon,
			r.max_lon,
			r.point_count,
			r.street_norm
		)
	}
	db.close()

	return path
}

describe("stripArrondissement", () => {
	it("strips a trailing French arrondissement designator to the base commune", () => {
		expect(stripArrondissement("paris 8e arrondissement")).toBe("paris")
		expect(stripArrondissement("lyon 1er arrondissement")).toBe("lyon")
		expect(stripArrondissement("marseille 10e arrondissement")).toBe("marseille")
	})

	it("is a no-op for every other commune", () => {
		expect(stripArrondissement("bordeaux")).toBe("bordeaux")
		expect(stripArrondissement("le touquet paris plage")).toBe("le touquet paris plage")
		expect(stripArrondissement("")).toBe("")
	})
})

describe("StreetCentroidSqliteLookup", () => {
	let lookup: StreetCentroidSqliteLookup

	beforeAll(async () => {
		const path = await seedShard([
			// "Place Bellecour" split across two arrondissement/postcode rows, both base-commune "lyon". The
			// weighted centroid over the two rows weights by point_count (10 @ lon 4.83, 30 @ lon 4.85).
			{
				street_norm: "place bellecour",
				postcode: "69002",
				locality_base: "lyon",
				lat: 45.757,
				lon: 4.83,
				min_lat: 45.756,
				max_lat: 45.758,
				min_lon: 4.829,
				max_lon: 4.831,
				point_count: 10,
			},
			{
				street_norm: "place bellecour",
				postcode: "69289",
				locality_base: "lyon",
				lat: 45.759,
				lon: 4.85,
				min_lat: 45.758,
				max_lat: 45.76,
				min_lon: 4.849,
				max_lon: 4.851,
				point_count: 30,
			},
			// A plain non-arrondissement commune.
			{
				street_norm: "cours de lintendance",
				postcode: "33000",
				locality_base: "bordeaux",
				lat: 44.842,
				lon: -0.577,
				min_lat: 44.841,
				max_lat: 44.843,
				min_lon: -0.579,
				max_lon: -0.575,
				point_count: 65,
			},
		])
		lookup = new StreetCentroidSqliteLookup(path, { streetLocale: "fr" })
	})

	afterAll(() => {
		lookup.close()
	})

	it("probes by postcode and returns the single-row centroid", () => {
		const hit = lookup.find({ street: "Cours de l'Intendance", postcode: "33000" })
		expect(hit).not.toBeNull()
		expect(hit!.lat).toBeCloseTo(44.842, 3)
		expect(hit!.lon).toBeCloseTo(-0.577, 3)
		expect(hit!.source).toBe("ban:fr")
		expect(hit!.release).toBe("2026-05-18")
		expect(hit!.uncertaintyM).toBeGreaterThan(0)
	})

	it("probes by base commune, folding a query arrondissement, and WEIGHTED-aggregates across rows", () => {
		// (10 @ 4.83 + 30 @ 4.85) / 40 = 4.845 — the point-count-weighted centroid, not the plain mean 4.84.
		const hit = lookup.find({ street: "Place Bellecour", locality: "Lyon 2e Arrondissement" })
		expect(hit).not.toBeNull()
		expect(hit!.lon).toBeCloseTo(4.845, 4)
		expect(hit!.lat).toBeCloseTo((45.757 * 10 + 45.759 * 30) / 40, 5)
	})

	it("folds the FR street normalizer on both sides (apostrophe/accents)", () => {
		// "Cours de l'Intendance" and its normalized key agree by construction.
		expect(lookup.find({ street: "cours de l'intendance", locality: "Bordeaux" })).not.toBeNull()
	})

	it("returns null on an exact-match miss (unknown street or wrong commune)", () => {
		expect(lookup.find({ street: "Place Bellecour", locality: "Paris" })).toBeNull()
		expect(lookup.find({ street: "Rue Inconnue", locality: "Lyon" })).toBeNull()
		expect(lookup.find({ street: "Place Bellecour", postcode: "75001" })).toBeNull()
	})
})
