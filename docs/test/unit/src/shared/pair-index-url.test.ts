/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pair-index asset URL construction (2026-08-05). History: the binaries were published flat at
 *   `mailwoman/pair-index/pair-index-<cc>.bin` and re-cut IN PLACE for PIX schema 3 — the objects
 *   carry `immutable` Cache-Control, so the CDN served the schema-1 bytes for a week while the
 *   site's reader threw on them (`schemaVersion 1 predates the typed parent record`), and the fix
 *   was a manual purge. Every other model-independent artifact (gazetteer, poi, national street
 *   shards) avoids that with a generation segment plus a site-side version constant; these tests
 *   pin the same scheme here.
 *
 *   The 2026-08-05 transition HEAD probe (`resolvePairIndexBaseURL`) is gone: its own removal
 *   condition — every generation object published under `pair-index/<PAIR_INDEX_VERSION>/` — was
 *   met, and the probe's aborted HEAD was the demo's last standing console error, failing every
 *   strict e2e run against production.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { PAIR_INDEX_VERSION, pairIndexBaseURL, pairIndexURLs } from "@mailwoman/docs/shared/resources"
import { fileURLToPath } from "@mailwoman/platform/url"
import { describe, expect, test } from "vitest"

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

// The regression the versioning scheme undoes was a bare base URL string literal in the loader
// (`const pairIndexBaseURL = "https://public.mailwoman.ai/mailwoman/pair-index"`), which is
// how the path escaped the versioning discipline the sibling assets follow. Keep the literal in
// resources/, where the version constant lives next to it.
const source = await readLocalTextFile(fileURLToPath(import.meta.resolve("@mailwoman/docs/shared/demo-loader")))

describe("the demo loader owns no pair-index URL of its own", () => {
	test("the loader does not build a bucket pair-index path itself", () => {
		expect(source).not.toMatch(/"https:\/\/public\.sister\.software\/mailwoman\/pair-index/)
	})

	test("the loader derives its base from the shared helper + version constant", () => {
		expect(source).toContain("pairIndexBaseURL(PAIR_INDEX_VERSION)")
	})
})
