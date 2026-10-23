/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pair-index asset URL construction.
 *
 *   The pair-index objects hold `immutable` Cache-Control, so a CDN keeps serving whatever bytes a URL
 *   first returned. Each generation therefore lives under its own `pair-index/<PAIR_INDEX_VERSION>/`
 *   segment, and the site reads the version constant. These tests pin that scheme.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
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
		expect(pairIndexBaseURL("2026-10-17")).toBe("https://public.mailwoman.ai/mailwoman/pair-index/2026-10-17")
	})

	test("every country the generation's manifest lists gets a binary URL under the base", () => {
		expect(pairIndexURLs(pairIndexBaseURL("2026-10-17"), ["gb", "nz", "us"])).toEqual([
			"https://public.mailwoman.ai/mailwoman/pair-index/2026-10-17/pair-index-gb.bin",
			"https://public.mailwoman.ai/mailwoman/pair-index/2026-10-17/pair-index-nz.bin",
			"https://public.mailwoman.ai/mailwoman/pair-index/2026-10-17/pair-index-us.bin",
		])
	})

	test("an empty manifest requests no binary", () => {
		expect(pairIndexURLs(pairIndexBaseURL("2026-10-17"), [])).toEqual([])
	})

	test("the manifest sits beside the binaries under the generation", () => {
		expect(pairIndexManifestURL(pairIndexBaseURL("2026-10-17"))).toBe(
			"https://public.mailwoman.ai/mailwoman/pair-index/2026-10-17/index.json"
		)
	})

	test("a trailing slash on the base does not double up", () => {
		expect(pairIndexURLs("https://x/pair-index/v1/", ["gb"])[0]).toBe("https://x/pair-index/v1/pair-index-gb.bin")
		expect(pairIndexManifestURL("https://x/pair-index/v1/")).toBe("https://x/pair-index/v1/index.json")
	})

	test("the version constant is a dated generation stamp, like its sibling artifacts", () => {
		expect(PAIR_INDEX_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}[a-z]?$/)
	})
})

// The regression the versioning scheme undoes was a bare base URL string literal in the
// loader (`const pairIndexBaseURL = "https://public.mailwoman.ai/mailwoman/pair-index"`),
// which is how the path escaped the versioning discipline the sibling assets follow.
// Keep the literal in resources/, where the version constant lives next to it.
const source = await readLocalTextFile(resolveModulePath("mailwoman/browser-runtime/load-assets"))

describe("the release loader owns no pair-index URL of its own", () => {
	test("the loader does not build a bucket pair-index path itself", () => {
		expect(source).not.toMatch(/"https:\/\/public\.sister\.software\/mailwoman\/pair-index/)
	})

	test("the loader takes its pair-index URLs from the shared load configuration", () => {
		expect(source).not.toContain("pairIndexURLs")
		expect(source).toContain("neuralClassifierLoadURLs(")
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
