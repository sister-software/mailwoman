/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Integration tests for `WOFSqlitePlaceLookup` against a real Who's On First SQLite distribution.
 *
 *   These are gated on the WOF DB being present on disk — the suite SKIPS (with a clear stderr
 *   message) if the path doesn't exist. CI runs against the fixture-only suites; operators with the
 *   real DB locally get an extra layer of validation.
 *
 *   Resolution order for the DB path:
 *
 *   1. `MAILWOMAN_WOF_DB` env var (explicit operator override).
 *   2. `/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db` (the canonical lab location
 *        documented in the README + handover doc).
 *
 *   Assumes the `place_search` FTS5 table is already built (run `mailwoman gazetteer build fts` ahead of
 *   time). The resolver throws a clear error if missing — that's a sufficient signal.
 */

import { existsSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import { dataRootPath } from "@mailwoman/core/utils"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { WOFSqlitePlaceLookup } from "./lookup.ts"

const DEFAULT_WOF_PATH = String(dataRootPath("wof", "whosonfirst-data-admin-us-latest.db"))
const wofPath = $public.MAILWOMAN_WOF_DB ?? DEFAULT_WOF_PATH
const hasWOFDb = existsSync(wofPath)

// vitest's describe.skipIf prints a helpful message at suite runtime.
const describeIfWOF = describe.skipIf(!hasWOFDb)

describeIfWOF(`WOFSqlitePlaceLookup integration against ${wofPath}`, () => {
	let lookup: WOFSqlitePlaceLookup

	beforeAll(() => {
		lookup = new WOFSqlitePlaceLookup({ databasePath: wofPath })
	})

	afterAll(() => {
		lookup?.close()
	})

	describe("lookup smoke tests", () => {
		test("`Paris` with locality filter returns >0 candidates, all containing Paris in US", async () => {
			// FTS5 token-match — `Saint Paris` is a legitimate hit, so the assertion is on substring
			// match rather than exact equality.
			const candidates = await lookup.findPlace({ text: "Paris", placetype: "locality", limit: 20 })
			expect(candidates.length).toBeGreaterThan(0)

			for (const c of candidates) {
				expect(c.name).toMatch(/Paris/)
				expect(c.placetype).toBe("locality")
				expect(c.country).toBe("US")
				expect(c.lat).toBeGreaterThan(0)
				expect(c.lon).toBeLessThan(0)
				expect(c.id).toBeGreaterThan(0)
			}
			// At least one of the candidates IS plain "Paris" (not "Saint Paris" / "South Paris" / etc).
			expect(candidates.some((c) => c.name === "Paris")).toBe(true)
		})

		test("`Springfield` with locality filter returns several distinct candidates", async () => {
			const candidates = await lookup.findPlace({ text: "Springfield", placetype: "locality", limit: 50 })
			// The US has dozens of Springfields — admin-us has many.
			expect(candidates.length).toBeGreaterThan(5)
			// All distinct ids
			const ids = new Set(candidates.map((c) => c.id))
			expect(ids.size).toBe(candidates.length)
		})

		test("placetype: 'neighbourhood' actually narrows to neighbourhoods", async () => {
			const candidates = await lookup.findPlace({ text: "Mission", placetype: "neighbourhood", limit: 10 })
			expect(candidates.length).toBeGreaterThan(0)

			for (const c of candidates) {
				expect(c.placetype).toBe("neighbourhood")
			}
		})

		test("country: 'FR' filter returns empty against the US-only admin shard", async () => {
			const candidates = await lookup.findPlace({ text: "Paris", country: "FR" })
			expect(candidates).toEqual([])
		})

		test("country: 'US' filter passes through all admin-us rows", async () => {
			const candidates = await lookup.findPlace({ text: "Springfield", country: "US", placetype: "locality", limit: 5 })
			expect(candidates.length).toBeGreaterThan(0)

			for (const c of candidates) {
				expect(c.country).toBe("US")
			}
		})

		test("empty / non-token text returns []", async () => {
			expect(await lookup.findPlace({ text: "" })).toEqual([])
			expect(await lookup.findPlace({ text: "   " })).toEqual([])
			expect(await lookup.findPlace({ text: "()" })).toEqual([])
		})

		test("query with FTS5-special characters doesn't crash", async () => {
			// FTS5 reserves quotes / parens / colons / etc. Our sanitizer strips all non-alphanumeric.
			await expect(lookup.findPlace({ text: "St. (Petersburg)" })).resolves.toBeInstanceOf(Array)
		})
	})

	describe("alt-name matching", () => {
		test("Japanese alternate-name query resolves to the underlying English place", async () => {
			// Ashley (US, IL) — admin-us ships a jpn alt: アシュリー (id 1108979833).
			const candidates = await lookup.findPlace({ text: "アシュリー", placetype: "locality", limit: 10 })
			expect(candidates.length).toBeGreaterThan(0)
			const ashley = candidates.find((c) => c.id === 1108979833)
			expect(ashley).toBeDefined()
			expect(ashley!.name).toBe("Ashley")
		})
	})

	describe("parent-constrained lookup", () => {
		test("parentID narrows children to direct + transitive descendants", async () => {
			// Pick the first Springfield candidate, then look up children of its parent.
			const springfields = await lookup.findPlace({ text: "Springfield", placetype: "locality", limit: 1 })
			expect(springfields.length).toBe(1)
			const parentID = springfields[0]!.parent_id
			expect(parentID).toBeDefined()

			// Now query for that Springfield by name, scoped to its parent. Should include itself plus
			// possibly other places under the same parent.
			const constrained = await lookup.findPlace({
				text: "Springfield",
				placetype: "locality",
				parentID: parentID!,
				limit: 50,
			})
			expect(constrained.length).toBeGreaterThan(0)
			expect(constrained.find((c) => c.id === springfields[0]!.id)).toBeDefined()
		})
	})

	describe("performance budget", () => {
		test("`findPlace` against the full US admin shard returns in <250ms", async () => {
			const start = Date.now()
			await lookup.findPlace({ text: "Springfield", placetype: "locality", limit: 10 })
			const elapsed = Date.now() - start
			expect(elapsed).toBeLessThan(250)
		})
	})
})

if (!hasWOFDb) {
	describe.skip("WOFSqlitePlaceLookup integration", () => {
		test(`skipped (WOF DB not present at ${wofPath} — set MAILWOMAN_WOF_DB or download via the README)`, () => {})
	})
}
