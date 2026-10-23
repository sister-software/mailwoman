/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Wire interface for the releases manifest, post-migration (2026-07-04). History: the acronym
 *   sweep capitalized the manifest reads while the published R2 json kept the legacy keys — every
 *   release read `undefined`, silently disabling the demo's WOF cascade and FST for three days.
 *   The resolution keeps the house casing and migrates the wire: the publisher writes
 *   `hasFST`/`hasWOFDB`, `normalizeReleasesManifest` is the single boundary that tolerates both
 *   key generations (old HF mirrors still use `hasFst`/`hasWofDb`), and no consumer reads raw
 *   wire keys outside it.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { afterEach, describe, expect, test, vi } from "vitest"

import { fetchPairIndexManifest, normalizeReleasesManifest } from "#browser-runtime/manifest"
import type { WireReleaseEntry } from "#browser-runtime/manifest"

const entry = (over: Partial<WireReleaseEntry>) => ({
	version: "vX",
	label: "",
	description: "",
	modelSize: "1 MB",
	tokenizerVocab: 1,
	steps: 1,
	...over,
})

describe("normalizeReleasesManifest — the single wire boundary", () => {
	test("house-cased wire keys pass through", () => {
		const m = normalizeReleasesManifest({
			locale: "en-us",
			defaultVersion: "vX",
			releases: [entry({ hasFST: true, hasWOFDB: true })],
		})

		expect(m.releases[0]).toMatchObject({ hasFST: true, hasWOFDB: true })
	})

	test("legacy wire keys (pre-2026-07-04 manifests, old HF mirrors) normalize", () => {
		const m = normalizeReleasesManifest({
			locale: "en-us",
			defaultVersion: "vX",
			releases: [entry({ hasFst: true, hasWofDb: true })],
		})

		expect(m.releases[0]).toMatchObject({ hasFST: true, hasWOFDB: true })
	})

	test("house keys win when both generations appear", () => {
		const m = normalizeReleasesManifest({
			locale: "en-us",
			defaultVersion: "vX",
			releases: [entry({ hasFST: false, hasFst: true, hasWOFDB: false, hasWofDb: true })],
		})

		expect(m.releases[0]).toMatchObject({ hasFST: false, hasWOFDB: false })
	})

	test("absent keys default false, never undefined (the silent-disable failure mode)", () => {
		const m = normalizeReleasesManifest({ locale: "en-us", defaultVersion: "vX", releases: [entry({})] })

		expect(m.releases[0]!.hasFST).toBe(false)
		expect(m.releases[0]!.hasWOFDB).toBe(false)
	})
})

describe("the default release falls back to one this runtime can load", () => {
	test("keeps a default whose required capabilities the runtime has", () => {
		const m = normalizeReleasesManifest({
			locale: "en-us",
			defaultVersion: "v10.1.0",
			releases: [entry({ version: "v10.1.0", requiresRuntime: ["locale_hint"] }), entry({ version: "v9.1.0" })],
		})

		expect(m.defaultVersion).toBe("v10.1.0")
	})

	test("passes over a default that needs a capability the runtime lacks, to the newest release it can load", () => {
		const m = normalizeReleasesManifest({
			locale: "en-us",
			defaultVersion: "v11.0.0",
			releases: [
				entry({ version: "v11.0.0", requiresRuntime: ["a-capability-from-the-future"] }),
				entry({ version: "v10.1.0", requiresRuntime: ["locale_hint"] }),
				entry({ version: "v9.1.0" }),
			],
		})

		expect(m.defaultVersion).toBe("v10.1.0")
	})
})

describe("no consumer reads raw legacy wire keys outside the boundary", () => {
	// Every other consumer reads through `ReleaseInfo`.
	// It contains no legacy key.
	// Therefore, a raw read there is a type error.
	// These two are the writer and the loader.
	// The type cannot see their string literals.
	for (const rel of ["lib/browser-runtime/load-assets.ts", "tools/release-tools/publish/hf.ts"]) {
		test(`${rel} is house-cased only`, async () => {
			const src = await readLocalTextFile(resolvePackagePath("mailwoman", rel))

			expect(src).not.toContain("hasFst")
			expect(src).not.toContain("hasWofDb")
		})
	}

	test("the LIVE 2026-08-11 wire spelling hasWOFDb (WOF caps, lowercase b) normalizes — the four-day demo outage's pin", () => {
		const m = normalizeReleasesManifest({
			locale: "en-us",
			defaultVersion: "v9.1.0",
			releases: [entry({ hasFST: true, hasWOFDb: true })],
		})

		expect(m.releases[0]!.hasWOFDB).toBe(true)
	})
})

describe("fetchPairIndexManifest — the countries a pair-index generation holds come from the bucket (#2768)", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	test("reads the generation's manifest from beside its binaries", async () => {
		const requested: string[] = []

		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			requested.push(String(input))

			return Response.json({ version: "2026-10-17", countries: ["gb", "nz", "us"] })
		})

		await expect(fetchPairIndexManifest("2026-10-17")).resolves.toEqual({
			version: "2026-10-17",
			countries: ["gb", "nz", "us"],
		})

		expect(requested).toEqual(["https://public.mailwoman.ai/mailwoman/pair-index/2026-10-17/index.json"])
	})

	test("answers null with a warning when the bucket holds no manifest at the generation", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }))

		await expect(fetchPairIndexManifest("2026-10-17")).resolves.toBeNull()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("pair-index/2026-10-17/index.json answered 404"))
	})

	test("answers null with a warning when the body is not a manifest", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		vi.stubGlobal("fetch", async () => Response.json({ countries: "gb" }))

		await expect(fetchPairIndexManifest("2026-10-17")).resolves.toBeNull()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("is not a {version, countries} document"))
	})
})
