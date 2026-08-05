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
 *   pin the same scheme here, plus the transition fallback that keeps the demo alive until the
 *   next release train stages the versioned path.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test, vi } from "vitest"

import {
	LEGACY_PAIR_INDEX_BASE_URL,
	PAIR_INDEX_COUNTRIES,
	PAIR_INDEX_VERSION,
	pairIndexBaseURL,
	pairIndexURLs,
	resolvePairIndexBaseURL,
} from "./resources.tsx"

const here = dirname(fileURLToPath(import.meta.url))

/**
 * A fetch double that answers only the URLs it is given, 404s everything else.
 */
function fetchDouble(ok: Set<string>) {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url)

		return { ok: ok.has(href), status: ok.has(href) ? 200 : 404, method: init?.method } as unknown as Response
	}) as unknown as typeof fetch
}

describe("pair-index URL construction", () => {
	test("a versioned base carries the generation segment", () => {
		expect(pairIndexBaseURL("2026-08-05")).toBe("https://public.sister.software/mailwoman/pair-index/2026-08-05")
	})

	test("every shipped country gets a binary URL under the base", () => {
		expect(pairIndexURLs(pairIndexBaseURL("2026-08-05"))).toEqual([
			"https://public.sister.software/mailwoman/pair-index/2026-08-05/pair-index-gb.bin",
			"https://public.sister.software/mailwoman/pair-index/2026-08-05/pair-index-nz.bin",
		])
	})

	test("a trailing slash on the base does not double up", () => {
		expect(pairIndexURLs("https://x/pair-index/v1/")[0]).toBe("https://x/pair-index/v1/pair-index-gb.bin")
	})

	test("the frozen legacy base is exactly the pre-2026-08-05 hardcoded path", () => {
		expect(LEGACY_PAIR_INDEX_BASE_URL).toBe("https://public.sister.software/mailwoman/pair-index")
	})

	test("the version constant is a dated generation stamp, like its sibling artifacts", () => {
		expect(PAIR_INDEX_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}[a-z]?$/)
	})
})

describe("resolvePairIndexBaseURL — the transition probe", () => {
	test("published generation → the versioned base, no warning", async () => {
		const versioned = pairIndexBaseURL(PAIR_INDEX_VERSION)
		const fetchImpl = fetchDouble(new Set([`${versioned}/pair-index-${PAIR_INDEX_COUNTRIES[0]}.bin`]))
		const warn = vi.fn()

		expect(await resolvePairIndexBaseURL(PAIR_INDEX_VERSION, { fetchImpl, warn })).toBe(versioned)
		expect(warn).not.toHaveBeenCalled()
	})

	test("probes the FIRST country's binary with HEAD — one request, no body", async () => {
		const fetchImpl = fetchDouble(new Set())
		await resolvePairIndexBaseURL("2026-08-05", { fetchImpl, warn: vi.fn() })

		expect(fetchImpl).toHaveBeenCalledTimes(1)

		expect(fetchImpl).toHaveBeenCalledWith(
			"https://public.sister.software/mailwoman/pair-index/2026-08-05/pair-index-gb.bin",
			{ method: "HEAD" }
		)
	})

	test("404 → the frozen legacy base, with a warning naming the generation and the migration", async () => {
		const warn = vi.fn()

		expect(await resolvePairIndexBaseURL("2026-08-05", { fetchImpl: fetchDouble(new Set()), warn })).toBe(
			LEGACY_PAIR_INDEX_BASE_URL
		)

		const message = warn.mock.calls[0]?.[0] as string
		expect(message).toContain("2026-08-05")
		expect(message).toContain("RELEASING.md")
	})

	test("a network/CORS failure is treated as unpublished, never fatal", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("Failed to fetch")
		}) as unknown as typeof fetch

		expect(await resolvePairIndexBaseURL("2026-08-05", { fetchImpl, warn: vi.fn() })).toBe(LEGACY_PAIR_INDEX_BASE_URL)
	})
})

describe("the demo loader owns no pair-index URL of its own", () => {
	// The regression this whole change undoes was a bare base URL string literal in the loader
	// (`const pairIndexBaseURL = "https://public.sister.software/mailwoman/pair-index"`), which is
	// how the path escaped the versioning discipline the sibling assets follow. Keep the literal in
	// resources.tsx, where the version constant lives next to it.
	const source = readFileSync(resolve(here, "demo-loader.ts"), "utf8")

	test("the loader does not build a bucket pair-index path itself", () => {
		expect(source).not.toMatch(/"https:\/\/public\.sister\.software\/mailwoman\/pair-index/)
	})

	test("the loader resolves its base through the shared helper", () => {
		expect(source).toContain("resolvePairIndexBaseURL()")
	})
})
