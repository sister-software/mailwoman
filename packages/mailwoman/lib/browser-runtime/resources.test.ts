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

import {
	neuralClassifierLoadURLs,
	PAIR_INDEX_VERSION,
	pairIndexBaseURL,
	pairIndexURLs,
} from "#browser-runtime/resources"

describe("pair-index URL construction", () => {
	test("a versioned base carries the generation segment", () => {
		expect(pairIndexBaseURL("2026-08-05")).toBe("https://public.mailwoman.ai/mailwoman/pair-index/2026-08-05")
	})

	test("every shipped country gets a binary URL under the base", () => {
		expect(pairIndexURLs(pairIndexBaseURL("2026-08-05"))).toEqual([
			"https://public.mailwoman.ai/mailwoman/pair-index/2026-08-05/pair-index-gb.bin",
			"https://public.mailwoman.ai/mailwoman/pair-index/2026-08-05/pair-index-nz.bin",
		])
	})

	test("a trailing slash on the base does not double up", () => {
		expect(pairIndexURLs("https://x/pair-index/v1/")[0]).toBe("https://x/pair-index/v1/pair-index-gb.bin")
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
	test("requests every published pair index from the versioned base", () => {
		const urls = neuralClassifierLoadURLs("en-US", "v1", { postcodeAnchor: "skip" })

		expect(urls.pairIndexURLs).toEqual(pairIndexURLs(pairIndexBaseURL(PAIR_INDEX_VERSION)))
		expect(urls.postcodeBinaryURLs).toEqual([])
	})

	test("requests the postcode binaries only when the anchor assets load", () => {
		const urls = neuralClassifierLoadURLs("en-US", "v1", { postcodeAnchor: "load" })

		expect(urls.postcodeBinaryURLs).toHaveLength(3)
	})
})
