// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { buildCacheName, deleteOtherBuildCaches } from "#build-caches"

import { MemoryCacheStorage } from "../test/memory-cache.ts"

describe("deleteOtherBuildCaches", () => {
	test("deletes the prefix's caches of other builds and keeps the current build's and every other cache", async () => {
		const storage = new MemoryCacheStorage()
		const current = new Set([buildCacheName("mailwoman-", "tiles", "5b13e9a1c")])

		for (const name of [
			"mailwoman-tiles-5b13e9a1c",
			"mailwoman-tiles-e1c124bd9",
			"mailwoman-tiles-v1",
			"mailwoman-db-ranges-v1",
			"workbox-precache-v2-https://earth.mailwoman.post/",
		]) {
			await storage.open(name)
		}

		await expect(deleteOtherBuildCaches(storage, "mailwoman-", current)).resolves.toEqual([
			"mailwoman-tiles-e1c124bd9",
			"mailwoman-tiles-v1",
			"mailwoman-db-ranges-v1",
		])

		await expect(storage.keys()).resolves.toEqual([
			"mailwoman-tiles-5b13e9a1c",
			"workbox-precache-v2-https://earth.mailwoman.post/",
		])
	})
})
