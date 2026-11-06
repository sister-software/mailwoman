/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { isPruneMessage, PRUNE_MESSAGE_TYPE, pruneOtherVersions } from "#prune"

import { MemoryCacheStorage } from "../test/memory-cache.ts"

describe("isPruneMessage", () => {
	test("accepts only a prune message with a string version", () => {
		expect(isPruneMessage({ type: PRUNE_MESSAGE_TYPE, keepVersion: "10.8.0" })).toBe(true)
		expect(isPruneMessage({ type: PRUNE_MESSAGE_TYPE, keepVersion: 10 })).toBe(false)
		expect(isPruneMessage({ type: "other", keepVersion: "10.8.0" })).toBe(false)
		expect(isPruneMessage(null)).toBe(false)
		expect(isPruneMessage("prune")).toBe(false)
	})
})

describe("pruneOtherVersions", () => {
	test("deletes the entries of other releases and keeps files outside any release", async () => {
		const cache = await new MemoryCacheStorage().open("assets")

		for (const url of [
			"https://public.example.test/mailwoman/en-us/v10.8.0/model.onnx",
			"https://public.example.test/mailwoman/en-us/v10.7.0/model.onnx",
			"https://public.example.test/mailwoman/en-us/v10.7.0/fst-en-us.bin",
			"https://public.example.test/mailwoman/en-us/v10.8.0-rc.1/model.onnx",
			"https://public.example.test/mailwoman/gazetteer/2026-08-25b/candidate.db?mwrange=0-65535",
			"https://public.example.test/undersea/gebco-2026-11-02/v2/undersea-features.geojson",
		]) {
			await cache.put(url, new Response("bytes"))
		}

		await expect(pruneOtherVersions(cache, "v10.8.0")).resolves.toBe(3)

		expect((await cache.keys()).map((request) => request.url)).toEqual([
			"https://public.example.test/mailwoman/en-us/v10.8.0/model.onnx",
			"https://public.example.test/mailwoman/gazetteer/2026-08-25b/candidate.db?mwrange=0-65535",
			"https://public.example.test/undersea/gebco-2026-11-02/v2/undersea-features.geojson",
		])
	})
})
