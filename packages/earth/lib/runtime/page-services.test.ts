// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import type { Gazetteer } from "#explorers/Gazette/gazetteer"
import type { PolygonDB } from "#runtime/basemap"
import { createPageScope, GazetteerService, PolygonDatabaseService, retireFailedHandle } from "#runtime/page-services"

type PageServiceOpeners = NonNullable<Parameters<typeof createPageScope>[1]>

/**
 * Openers that count each open and record each close, with a polygon open that fails while `failing` is set.
 */
function countingOpeners() {
	const log: string[] = []
	const state = { opens: 0, failing: false }

	const openers: PageServiceOpeners = {
		openPolygons: async (): Promise<PolygonDB> => {
			if (state.failing) throw new Error("Range 0-65535 of wof-polygons.db returned HTTP 502")

			const generation = ++state.opens

			return { get: async () => null, close: () => void log.push(`closed polygons ${generation}`) }
		},
		openGazetteer: async (): Promise<Gazetteer> => {
			log.push("opened gazetteer")

			return {
				database: { query: async () => [], bytesRead: async () => 0, close: () => void log.push("closed gazetteer") },
				codes: { placetypes: new Map(), countries: new Map() },
				version: "2026-08-25",
			}
		},
	}

	return { openers, log, state }
}

describe("createPageScope", () => {
	test("shares one open across concurrent reads, and opens no handle a page never reads", async () => {
		const { openers, log, state } = countingOpeners()

		await using scope = createPageScope("/sqlite", openers)

		const [first, second] = await Promise.all([
			scope.resolve(PolygonDatabaseService),
			scope.resolve(PolygonDatabaseService),
		])

		expect(first).toBe(second)
		expect(state.opens).toBe(1)
		expect(log).toEqual([])
	})

	test("forgets a failed open, so the next read opens again", async () => {
		const { openers, state } = countingOpeners()

		await using scope = createPageScope("/sqlite", openers)

		state.failing = true
		await expect(scope.resolve(PolygonDatabaseService)).rejects.toThrow("HTTP 502")

		state.failing = false
		await scope.resolve(PolygonDatabaseService)

		expect(state.opens).toBe(1)
	})

	test("an invalidation closes the open handle's worker, and the next read opens a new one", async () => {
		const { openers, log, state } = countingOpeners()

		await using scope = createPageScope("/sqlite", openers)

		const first = await scope.resolve(PolygonDatabaseService)

		await scope.invalidate(PolygonDatabaseService, new Error("SQLITE_IOERR_READ"))

		expect(log).toEqual(["closed polygons 1"])
		expect(await scope.resolve(PolygonDatabaseService)).not.toBe(first)
		expect(state.opens).toBe(2)
	})

	test("disposal closes each handle the page opened", async () => {
		const { openers, log } = countingOpeners()
		const scope = createPageScope("/sqlite", openers)

		await scope.resolve(PolygonDatabaseService)
		await scope.resolve(GazetteerService)
		await scope.dispose()

		expect(log).toEqual(["opened gazetteer", "closed gazetteer", "closed polygons 1"])
	})
})

describe("retireFailedHandle", () => {
	test("closes the open handle a read failed on, and the next read opens a new one", async () => {
		const { openers, log, state } = countingOpeners()

		await using scope = createPageScope("/sqlite", openers)

		const failed = await scope.resolve(PolygonDatabaseService)

		retireFailedHandle(scope, PolygonDatabaseService, failed, new Error("SQLITE_IOERR_READ"))
		await scope.resolve(PolygonDatabaseService)

		expect(log).toEqual(["closed polygons 1"])
		expect(state.opens).toBe(2)
	})

	test("leaves a newer handle open when a read on an already closed handle reports its failure", async () => {
		const { openers, log, state } = countingOpeners()

		await using scope = createPageScope("/sqlite", openers)

		const first = await scope.resolve(PolygonDatabaseService)
		const failure = new Error("The range database is closed")

		retireFailedHandle(scope, PolygonDatabaseService, first, failure)

		const second = await scope.resolve(PolygonDatabaseService)

		// A second read that was in flight on the first handle rejects when that handle closes.
		retireFailedHandle(scope, PolygonDatabaseService, first, failure)

		expect(await scope.resolve(PolygonDatabaseService)).toBe(second)
		expect(log).toEqual(["closed polygons 1"])
		expect(state.opens).toBe(2)
	})
})
