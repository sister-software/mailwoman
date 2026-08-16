/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The dispatch half of `mwdev_lookup`: which artifact each source resolves, and what it says when that artifact is
 *   not there. Every case here pins the same rule — an absent artifact returns `unavailable_reason` and NO rows, never
 *   a row per query saying "no", which is the shape a genuine absence has.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

import { resolvePath } from "path-ts"
import { describe, expect, it } from "vitest"

import type { EngineRegistry } from "./engine-registry.ts"
import { runLookup } from "./lookup-tool.ts"

/**
 * The five artifact-backed sources never touch the registry; passing one that would throw proves it.
 */
const noRegistry = new Proxy({} as EngineRegistry, {
	get() {
		throw new Error("this source must not build an engine")
	},
})

const emptyRoot = mkdtempSync(resolvePath(tmpdir(), "mwdev-lookup-"))

describe("runLookup", () => {
	it("reports a pinned candidate path BY NAME rather than as an unresolved one", async () => {
		// `resolveCandidateDBPath` answers `undefined` for a pinned path that does not exist, which is right for the
		// runtime and wrong to relay: someone who typo'd the flag would be told the gazetteer is missing.
		const result = await runLookup(noRegistry, {
			source: "candidate",
			queries: ["Vaduz"],
			config: { candidate_db: "/nonexistent/typo.db" },
		})

		expect(result.rows).toEqual([])
		expect(result.unavailable_reason).toContain("/nonexistent/typo.db")
	})

	it("returns no rows at all when an artifact is missing", async () => {
		const result = await runLookup(noRegistry, {
			source: "poi",
			queries: ["Eiffel Tower", "Sultan Qaboos Grand Mosque"],
			config: { data_root: emptyRoot },
		})

		expect(result.rows).toEqual([])
		expect(result.unavailable_reason).toContain("poi.db")
		expect(result.notes.join(" ")).toContain("would read as absence for every query")
	})

	it("treats an unopenable WOF shard set as unavailable, not as a gazetteer with nothing in it", async () => {
		const result = await runLookup(noRegistry, {
			source: "wof",
			queries: ["Vaduz"],
			config: { resolve_db: resolvePath(emptyRoot, "no-such-shard.db") },
		})

		expect(result.rows).toEqual([])
		expect(result.unavailable_reason).toContain("No WOF shard could be opened")
	})

	it("says a locale ships no anchor artifact instead of answering no for every postcode", async () => {
		const result = await runLookup(noRegistry, { source: "postcode", queries: ["10118"], locale: "zz-zz" })

		expect(result.rows).toEqual([])
		expect(result.unavailable_reason).toContain("zz-zz")
	})

	it("answers codex without an artifact, so it can never be unavailable", async () => {
		const result = await runLookup(noRegistry, { source: "codex", queries: ["90210", "Zzzz"] })

		expect(result.unavailable_reason).toBeUndefined()
		expect(result.rows.map((row) => row.hit)).toEqual([true, false])
	})

	it("answers normalize without an artifact too", async () => {
		const result = await runLookup(noRegistry, { source: "normalize", queries: ["  spaced   out  "] })

		expect(result.unavailable_reason).toBeUndefined()
		expect(result.rows[0]).toMatchObject({ hit: true })
	})
})
