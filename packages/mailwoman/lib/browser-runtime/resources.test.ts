// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Pair-index asset URL construction.
 *
 *   The pair-index objects hold `immutable` Cache-Control, so a CDN keeps serving
 *   whatever bytes a URL first returned.
 *   Each generation therefore lives under its own `pair-index/<PAIR_INDEX_VERSION>/`
 *   segment, and the site reads the version constant.
 *   These tests pin that scheme.
 */

import { describe, expect, test } from "vitest"

import { postcodeAnchorFilesOf, postcodePrefixFilesOf } from "#browser-runtime/manifest"
import {
	assetURL,
	neuralClassifierLoadURLs,
	PAIR_INDEX_VERSION,
	pairIndexBaseURL,
	pairIndexManifestURL,
	pairIndexURLs,
} from "#browser-runtime/resources"

describe("pair-index URL construction", () => {
	test("a versioned base carries the generation segment", () => {
		expect(pairIndexBaseURL("2026-10-17")).toBe("https://public.mailwoman.post/mailwoman/pair-index/2026-10-17")
	})

	test("every country the generation's manifest lists gets a binary URL under the base", () => {
		expect(pairIndexURLs(pairIndexBaseURL("2026-10-17"), ["gb", "nz", "us"])).toEqual([
			"https://public.mailwoman.post/mailwoman/pair-index/2026-10-17/pair-index-gb.bin",
			"https://public.mailwoman.post/mailwoman/pair-index/2026-10-17/pair-index-nz.bin",
			"https://public.mailwoman.post/mailwoman/pair-index/2026-10-17/pair-index-us.bin",
		])
	})

	test("an empty manifest requests no binary", () => {
		expect(pairIndexURLs(pairIndexBaseURL("2026-10-17"), [])).toEqual([])
	})

	test("the manifest sits beside the binaries under the generation", () => {
		expect(pairIndexManifestURL(pairIndexBaseURL("2026-10-17"))).toBe(
			"https://public.mailwoman.post/mailwoman/pair-index/2026-10-17/index.json"
		)
	})

	test("a trailing slash on the base does not double up", () => {
		expect(pairIndexURLs("https://x/pair-index/v1/", ["gb"])[0]).toBe("https://x/pair-index/v1/pair-index-gb.bin")
		expect(pairIndexManifestURL("https://x/pair-index/v1/")).toBe("https://x/pair-index/v1/index.json")
	})
})

describe("neuralClassifierLoadURLs — one configuration for the primary and comparison loads", () => {
	test("requests every pair index the generation's manifest lists, from the versioned base", () => {
		const urls = neuralClassifierLoadURLs("en-US", "v1", { postcodeAnchors: [], pairIndexCountries: ["gb", "us"] })

		expect(urls.pairIndexURLs).toEqual(pairIndexURLs(pairIndexBaseURL(PAIR_INDEX_VERSION), ["gb", "us"]))
		expect(urls.postcodeBinaryURLs).toEqual([])
	})

	test("requests each postcode binary the release lists", () => {
		const urls = neuralClassifierLoadURLs("en-US", "v1", {
			postcodeAnchors: ["postcode-gb.bin"],
			pairIndexCountries: [],
		})

		expect(urls.postcodeBinaryURLs).toEqual([assetURL("en-US", "v1", "postcode-gb.bin")])
		expect(urls.postcodePrefixURLs).toEqual([])
	})

	test("requests each postcode-prefix index the release lists, from the release directory", () => {
		const urls = neuralClassifierLoadURLs("en-US", "v1", {
			postcodeAnchors: [],
			pairIndexCountries: [],
			postcodePrefixes: ["postcode-prefix-us.bin"],
		})

		expect(urls.postcodePrefixURLs).toEqual([assetURL("en-US", "v1", "postcode-prefix-us.bin")])
	})
})

describe("postcodePrefixFilesOf", () => {
	test("lists the release's indexes and none for an entry published before the field", () => {
		expect(postcodePrefixFilesOf({ postcodePrefixes: ["postcode-prefix-us.bin"] })).toEqual(["postcode-prefix-us.bin"])
		expect(postcodePrefixFilesOf({})).toEqual([])
		expect(postcodePrefixFilesOf(null)).toEqual([])
	})
})

describe("postcodeAnchorFilesOf", () => {
	test("reads the entry's list", () => {
		expect(postcodeAnchorFilesOf({ hasAnchor: true, postcodeAnchors: ["postcode-gb.bin"] })).toEqual([
			"postcode-gb.bin",
		])
	})

	test("reads an entry without a list as the files those releases shipped", () => {
		expect(postcodeAnchorFilesOf({ hasAnchor: true })).toEqual([
			"postcode-us.bin",
			"postcode-de.bin",
			"postcode-fr.bin",
		])

		expect(postcodeAnchorFilesOf({ hasAnchor: false })).toEqual([])
		expect(postcodeAnchorFilesOf(null)).toEqual([])
	})
})
