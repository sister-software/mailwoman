import { tempRootPath } from "@mailwoman/core/data-root"
import { writeLocalBuffer, writeLocalFile } from "@mailwoman/core/fs/writers"
import { autocomplete, type FSTMatcher, normalizeTokens, serializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { resolveFSTPath, runAutocomplete } from "#autocomplete-core"
import { buildFixtureFST, FIXTURE_FST_PLACES } from "#test-kit/fst-fixture"

let fixtureMatcher: FSTMatcher
let fixtureBinPath: string

beforeAll(async () => {
	fixtureMatcher = buildFixtureFST(FIXTURE_FST_PLACES)

	const buf = serializeFST(fixtureMatcher)
	fixtureBinPath = tempRootPath(`mailwoman-fst-fixture-${Date.now()}.bin`)
	await writeLocalFile(buf, fixtureBinPath)
})

describe("normalizeTokens symmetry", () => {
	it("lowercases ASCII", () => {
		expect(normalizeTokens("New York")).toEqual(["new", "york"])
	})

	it("strips punctuation", () => {
		expect(normalizeTokens("St. Paul")).toEqual(["st", "paul"])
	})

	it("applies NFKC — composed characters are normalized but diacritics are preserved", () => {
		const tokens = normalizeTokens("San José")
		expect(tokens).toEqual(["san", "josé"])
	})

	it("returns empty array for whitespace-only input", () => {
		expect(normalizeTokens("   ")).toEqual([])
	})
})

describe("autocomplete — in-memory fixture", () => {
	it("returns suggestions for prefix 'New'", () => {
		const result = autocomplete(fixtureMatcher, "New", { maxSuggestions: 10 })
		expect(result.suggestions.length).toBeGreaterThan(0)
		const names = result.suggestions.map((s) => s.name.toLowerCase())
		expect(names.some((n) => n.includes("new"))).toBe(true)
	})

	it("returns an exact match for 'New York'", () => {
		const result = autocomplete(fixtureMatcher, "New York", { maxSuggestions: 10 })
		const exactMatches = result.suggestions.filter((s) => s.completionTokens.length === 0)
		expect(exactMatches.length).toBeGreaterThanOrEqual(1)
		const types = exactMatches.map((s) => s.placetype)
		expect(types).toContain("region")
	})

	it("returns no suggestions for an unknown prefix", () => {
		const result = autocomplete(fixtureMatcher, "Xyzzyplugh")
		expect(result.suggestions).toHaveLength(0)
	})

	it("ranks by importance (prominent places first)", () => {
		const result = autocomplete(fixtureMatcher, "San", { maxSuggestions: 5 })
		expect(result.suggestions.length).toBeGreaterThan(0)

		if (result.suggestions.length >= 2) {
			expect(result.suggestions[0]!.referential).toBeGreaterThanOrEqual(result.suggestions[1]!.referential)
		}
	})

	it("prefix 'San' yields San Francisco as the top result (highest referential)", () => {
		const result = autocomplete(fixtureMatcher, "San", { maxSuggestions: 5 })
		expect(result.suggestions.length).toBeGreaterThan(0)
		expect(result.suggestions[0]!.name).toBe("San Francisco")
		expect(result.suggestions[0]!.referential).toBeGreaterThan(result.suggestions[1]!.referential)
	})

	it("prefix query is case-insensitive — matches the build-time normalizer", () => {
		const lower = autocomplete(fixtureMatcher, "new york", { maxSuggestions: 5 })
		const upper = autocomplete(fixtureMatcher, "NEW YORK", { maxSuggestions: 5 })
		expect(lower.suggestions.map((s) => s.wofID)).toEqual(upper.suggestions.map((s) => s.wofID))
	})

	it("respects maxSuggestions cap", () => {
		const result = autocomplete(fixtureMatcher, "New", { maxSuggestions: 1 })
		expect(result.suggestions.length).toBeLessThanOrEqual(1)
	})
})

describe("runAutocomplete — disk round-trip", () => {
	it("reads the fixture bin and returns completions for 'New'", async () => {
		const entries = await runAutocomplete("New", { fstPath: fixtureBinPath, limit: 10 })
		expect(entries.length).toBeGreaterThan(0)
		const names = entries.map((e) => e.name.toLowerCase())
		expect(names.some((n) => n.includes("new"))).toBe(true)
	})

	it("honors the limit cap", async () => {
		const entries = await runAutocomplete("New", { fstPath: fixtureBinPath, limit: 1 })
		expect(entries.length).toBeLessThanOrEqual(1)
	})

	it("throws a human-readable error for a missing FST path", async () => {
		await expect(runAutocomplete("New", { fstPath: "/nonexistent/path/fst-does-not-exist.bin" })).rejects.toThrow(
			/FST binary not found/
		)
	})

	it("throws a human-readable error for a malformed FST buffer", async () => {
		const badPath = tempRootPath(`mailwoman-fst-bad-${Date.now()}.bin`)
		await writeLocalBuffer(Buffer.from("not-an-fst-binary"), badPath)
		await expect(runAutocomplete("New", { fstPath: badPath })).rejects.toThrow(/Malformed FST binary/)
	})

	it("returns empty array for an unknown prefix", async () => {
		const entries = await runAutocomplete("Xyzzyplugh", { fstPath: fixtureBinPath })
		expect(entries).toEqual([])
	})

	it("round-trips importance and wofID through serialization", async () => {
		const entries = await runAutocomplete("United", { fstPath: fixtureBinPath, limit: 5 })
		const us = entries.find((e) => e.wofID === 85_633_793)
		expect(us).toBeDefined()

		expect(us!.referential).toBeCloseTo(0.99, 1)
	})
})

describe("resolveFSTPath", () => {
	// A data root with no active selection, so the default is the conventional path under it.
	const emptyRoot = tempRootPath(`mailwoman-fst-root-${Date.now()}`)

	it("returns the explicit path when given one", async () => {
		expect(await resolveFSTPath("/explicit/path.bin", emptyRoot)).toBe("/explicit/path.bin")
	})

	it("falls back to the application data directory when no explicit path, env var or selection", async () => {
		vi.stubEnv("MAILWOMAN_FST_BIN", undefined)

		try {
			expect((await resolveFSTPath(undefined, emptyRoot)).toString()).toBe(
				wofDatabaseRoot(emptyRoot)("fst-per-locale", "fst-en-us.bin").toString()
			)
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("prefers $MAILWOMAN_FST_BIN over the application data directory", async () => {
		vi.stubEnv("MAILWOMAN_FST_BIN", "/env/path.bin")

		try {
			expect(await resolveFSTPath(undefined, emptyRoot)).toBe("/env/path.bin")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("explicit path takes precedence over env var", async () => {
		vi.stubEnv("MAILWOMAN_FST_BIN", "/env/path.bin")

		try {
			expect(await resolveFSTPath("/explicit/path.bin", emptyRoot)).toBe("/explicit/path.bin")
		} finally {
			vi.unstubAllEnvs()
		}
	})
})
