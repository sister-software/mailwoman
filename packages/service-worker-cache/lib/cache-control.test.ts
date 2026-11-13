// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { answerCacheControl, CACHE_CONTROL_MESSAGE_TYPE, isCacheControlMessage } from "#cache-control"

import { MemoryCacheStorage } from "../test/memory-cache.ts"

const ROLES = {
	tiles: "mailwoman-tiles",
	"release-assets": "mailwoman-release-assets",
	"app-assets": "mailwoman-app-assets-5b13e9a1c",
}

describe("isCacheControlMessage", () => {
	test("reads a usage request and a clear request with string roles, and refuses others", () => {
		expect(isCacheControlMessage({ type: CACHE_CONTROL_MESSAGE_TYPE, action: "usage" })).toBe(true)
		expect(isCacheControlMessage({ type: CACHE_CONTROL_MESSAGE_TYPE, action: "clear", roles: ["tiles"] })).toBe(true)
		expect(isCacheControlMessage({ type: CACHE_CONTROL_MESSAGE_TYPE, action: "clear", roles: [1] })).toBe(false)
		expect(isCacheControlMessage({ type: CACHE_CONTROL_MESSAGE_TYPE, action: "drop" })).toBe(false)
		expect(isCacheControlMessage({ type: "SKIP_WAITING" })).toBe(false)
	})
})

describe("answerCacheControl", () => {
	test("reports each role's entry count, with zero for a cache never opened", async () => {
		const storage = new MemoryCacheStorage()
		const tiles = await storage.open("mailwoman-tiles")

		await tiles.put("https://tiles.example.test/base/1/0/0.mvt", new Response("a"))
		await tiles.put("https://tiles.example.test/base/1/0/1.mvt", new Response("b"))

		await expect(
			answerCacheControl({ type: CACHE_CONTROL_MESSAGE_TYPE, action: "usage" }, storage, ROLES)
		).resolves.toEqual({
			action: "usage",
			usage: [
				{ role: "tiles", cacheName: "mailwoman-tiles", entries: 2 },
				{ role: "release-assets", cacheName: "mailwoman-release-assets", entries: 0 },
				{ role: "app-assets", cacheName: "mailwoman-app-assets-5b13e9a1c", entries: 0 },
			],
		})
	})

	test("clears the listed roles' caches and skips a role outside the map", async () => {
		const storage = new MemoryCacheStorage()

		await storage.open("mailwoman-tiles")
		await storage.open("mailwoman-release-assets")
		await storage.open("workbox-precache-v2-https://earth.example.test/")

		const reply = await answerCacheControl(
			{ type: CACHE_CONTROL_MESSAGE_TYPE, action: "clear", roles: ["tiles", "workbox-precache"] },
			storage,
			ROLES
		)

		expect(reply).toEqual({ action: "clear", cleared: ["tiles"] })

		await expect(storage.keys()).resolves.toEqual([
			"mailwoman-release-assets",
			"workbox-precache-v2-https://earth.example.test/",
		])
	})
})
