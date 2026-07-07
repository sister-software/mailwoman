/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the `mailwoman autocomplete` command.
 *
 *   Fixture FST is built in-memory with a tiny hand-coded trie so tests don't depend on a live WOF
 *   DB. The trie is built using `normalizeTokens` (exactly as the real builder does) to honour the
 *   symmetry contract from issue #190.
 */

import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeAll, describe, expect, it, vi } from "vitest"

import { autocomplete } from "../../resolver-wof-sqlite/fst-autocomplete.js"
import { FSTMatcher, normalizeTokens } from "../../resolver-wof-sqlite/fst-matcher.js"
import { serializeFST } from "../../resolver-wof-sqlite/fst-serialize.js"
import { resolveFSTPath, runAutocomplete } from "./autocomplete.js"

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface FixturePlace {
	wofID: number
	placetype: string
	name: string
	importance: number
	parentChain: number[]
}

type FSTNodeInternal = { edges: Map<string, number>; places: FixtureEntry[] }
type FixtureEntry = FixturePlace & { lat: number; lon: number }

/** Build a minimal FSTMatcher from a list of places, using normalizeTokens exactly as the builder. */
function buildFixtureMatcher(places: FixturePlace[]): FSTMatcher {
	const entries: FixtureEntry[] = places.map((p) => ({ ...p, lat: 0, lon: 0 }))
	const nodes: FSTNodeInternal[] = [{ edges: new Map(), places: [] }]

	for (const entry of entries) {
		const tokens = normalizeTokens(entry.name)

		if (tokens.length === 0) continue
		let stateID = 0

		for (const t of tokens) {
			const node = nodes[stateID]!
			let next = node.edges.get(t)

			if (next === undefined) {
				next = nodes.length
				nodes.push({ edges: new Map(), places: [] })
				node.edges.set(t, next)
			}
			stateID = next
		}
		const node = nodes[stateID]!

		if (!node.places.some((p) => p.wofID === entry.wofID)) {
			node.places.push(entry)
		}
	}

	return FSTMatcher.fromNodes(nodes)
}

const FIXTURE_PLACES: FixturePlace[] = [
	{ wofID: 85977539, placetype: "locality", name: "New York City", importance: 0.9, parentChain: [85688543, 85633793] },
	{ wofID: 85688543, placetype: "region", name: "New York", importance: 0.75, parentChain: [85633793] },
	{ wofID: 85935903, placetype: "locality", name: "New Orleans", importance: 0.6, parentChain: [85688481, 85633793] },
	{
		wofID: 85922583,
		placetype: "locality",
		name: "San Francisco",
		importance: 0.85,
		parentChain: [102087579, 85633793],
	},
	{ wofID: 85919487, placetype: "locality", name: "San Jose", importance: 0.5, parentChain: [102087579, 85633793] },
	{ wofID: 85633793, placetype: "country", name: "United States", importance: 0.99, parentChain: [] },
]

let fixtureMatcher: FSTMatcher
let fixtureBinPath: string

beforeAll(() => {
	fixtureMatcher = buildFixtureMatcher(FIXTURE_PLACES)

	// Write the serialized fixture to a temp file so runAutocomplete (which reads from disk) can be
	// tested end-to-end.
	const buf = serializeFST(fixtureMatcher)
	fixtureBinPath = join(tmpdir(), `mailwoman-fst-fixture-${Date.now()}.bin`)
	writeFileSync(fixtureBinPath, buf)
})

// ---------------------------------------------------------------------------
// normalizeTokens symmetry smoke-test
// ---------------------------------------------------------------------------

describe("normalizeTokens symmetry", () => {
	it("lowercases ASCII", () => {
		expect(normalizeTokens("New York")).toEqual(["new", "york"])
	})

	it("strips punctuation", () => {
		expect(normalizeTokens("St. Paul")).toEqual(["st", "paul"])
	})

	it("applies NFKC — composed characters are normalized but diacritics are preserved", () => {
		// normalizeTokens applies NFKC + lowercase + punctuation strip. It does NOT decompose or
		// strip diacritics — that's intentional so that "José" and "Jose" are treated as distinct
		// tokens at both build time and query time (symmetry preserved).
		const tokens = normalizeTokens("San José")
		expect(tokens).toEqual(["san", "josé"])
	})

	it("returns empty array for whitespace-only input", () => {
		expect(normalizeTokens("   ")).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// In-memory autocomplete (FSTMatcher directly, no disk I/O)
// ---------------------------------------------------------------------------

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
		expect(result.suggestions.length).toBe(0)
	})

	it("ranks by importance (prominent places first)", () => {
		const result = autocomplete(fixtureMatcher, "San", { maxSuggestions: 5 })
		expect(result.suggestions.length).toBeGreaterThan(0)

		if (result.suggestions.length >= 2) {
			expect(result.suggestions[0]!.importance).toBeGreaterThanOrEqual(result.suggestions[1]!.importance)
		}
	})

	it("prefix 'San' yields San Francisco as the top result (highest importance)", () => {
		// The FST is token-based: "San Fr" would require a token edge for "fr" which doesn't exist.
		// The correct prefix is the full first token "San" — the BFS expansion then finds "Francisco"
		// and "Jose" as the one-token continuations, ranked by importance.
		const result = autocomplete(fixtureMatcher, "San", { maxSuggestions: 5 })
		expect(result.suggestions.length).toBeGreaterThan(0)
		expect(result.suggestions[0]!.name).toBe("San Francisco")
		expect(result.suggestions[0]!.importance).toBeGreaterThan(result.suggestions[1]!.importance)
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

// ---------------------------------------------------------------------------
// runAutocomplete — disk round-trip
// ---------------------------------------------------------------------------

describe("runAutocomplete — disk round-trip", () => {
	it("reads the fixture bin and returns completions for 'New'", async () => {
		const entries = await runAutocomplete("New", { fstPath: fixtureBinPath, limit: 10 })
		expect(entries.length).toBeGreaterThan(0)
		const names = entries.map((e) => e.name.toLowerCase())
		expect(names.some((n) => n.includes("new"))).toBe(true)
	})

	it("honours the limit cap", async () => {
		const entries = await runAutocomplete("New", { fstPath: fixtureBinPath, limit: 1 })
		expect(entries.length).toBeLessThanOrEqual(1)
	})

	it("throws a human-readable error for a missing FST path", async () => {
		await expect(runAutocomplete("New", { fstPath: "/nonexistent/path/fst-does-not-exist.bin" })).rejects.toThrow(
			/FST binary not found/
		)
	})

	it("throws a human-readable error for a malformed FST buffer", async () => {
		const badPath = join(tmpdir(), `mailwoman-fst-bad-${Date.now()}.bin`)
		writeFileSync(badPath, Buffer.from("not-an-fst-binary"))
		await expect(runAutocomplete("New", { fstPath: badPath })).rejects.toThrow(/Malformed FST binary/)
	})

	it("returns empty array for an unknown prefix", async () => {
		const entries = await runAutocomplete("Xyzzyplugh", { fstPath: fixtureBinPath })
		expect(entries).toEqual([])
	})

	it("round-trips importance and wofID through serialization", async () => {
		const entries = await runAutocomplete("United", { fstPath: fixtureBinPath, limit: 5 })
		const us = entries.find((e) => e.wofID === 85633793)
		expect(us).toBeDefined()
		// Float32 round-trip may introduce tiny epsilon; check within tolerance.
		expect(us!.importance).toBeCloseTo(0.99, 1)
	})
})

// ---------------------------------------------------------------------------
// resolveFSTPath
// ---------------------------------------------------------------------------

describe("resolveFSTPath", () => {
	it("returns the explicit path when given one", () => {
		expect(resolveFSTPath("/explicit/path.bin")).toBe("/explicit/path.bin")
	})

	it("falls back to the staged default when no explicit path and no env var", () => {
		vi.stubEnv("MAILWOMAN_FST_BIN", undefined as unknown as string)

		try {
			expect(resolveFSTPath()).toBe("/tmp/v440-stage/en-us/v4.4.0/fst-en-US.bin")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("prefers $MAILWOMAN_FST_BIN over the staged default", () => {
		vi.stubEnv("MAILWOMAN_FST_BIN", "/env/path.bin")

		try {
			expect(resolveFSTPath()).toBe("/env/path.bin")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("explicit path takes precedence over env var", () => {
		vi.stubEnv("MAILWOMAN_FST_BIN", "/env/path.bin")

		try {
			expect(resolveFSTPath("/explicit/path.bin")).toBe("/explicit/path.bin")
		} finally {
			vi.unstubAllEnvs()
		}
	})
})
