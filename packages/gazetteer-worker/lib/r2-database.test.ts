// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, test } from "vitest"

import { openR2Database } from "#r2-database"

const KEY = "fixture/candidate.db"

const fixture = Uint8Array.from(atob(env.CANDIDATE_FIXTURE_BASE64), (character) => character.charCodeAt(0))

beforeAll(async () => {
	await env.PUBLIC_BUCKET.put(KEY, fixture)
})

describe("openR2Database", () => {
	test("answers a query by reading the object through R2 range reads", async () => {
		const database = await openR2Database(env.PUBLIC_BUCKET, KEY, { chunkSize: 4096 })

		const rows = await database.query<{ name: string; spr_id: number }>(
			"SELECT name, spr_id FROM candidate WHERE name_key = ? ORDER BY spr_id",
			["springfield"]
		)

		expect(rows.map((row) => row.spr_id)).toEqual([85_940_195, 85_950_393, 85_971_363])

		const { bytes, requests } = database.stats()

		expect(requests).toBeGreaterThan(1)
		expect(bytes).toBeLessThanOrEqual(fixture.byteLength)
		await expect(database.bytesRead()).resolves.toBe(bytes)
	})

	test("evicts the least recently used chunk once the cache is full", async () => {
		const database = await openR2Database(env.PUBLIC_BUCKET, KEY, { chunkSize: 4096, maxChunks: 2 })

		await database.query("SELECT count(*) AS rows FROM padding")

		expect(database.stats().cachedChunks).toBe(2)
	})

	test("answers concurrent queries one after another with each query's own rows", async () => {
		const database = await openR2Database(env.PUBLIC_BUCKET, KEY, { chunkSize: 4096 })

		const [codes, padding] = await Promise.all([
			database.query<{ code: string }>("SELECT code FROM country_codes"),
			database.query<{ id: number }>("SELECT id FROM padding WHERE id = ?", [1999]),
		])

		expect(codes).toEqual([{ code: "US" }])
		expect(padding).toEqual([{ id: 1999 }])
	})

	test("refuses a key the bucket does not hold", async () => {
		await expect(openR2Database(env.PUBLIC_BUCKET, "absent/candidate.db")).rejects.toThrow(/absent from the bucket/)
	})
})
