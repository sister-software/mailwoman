/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Test source artifact resolution and ensure missing artifacts return `unavailable_reason`, not query misses.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { EngineRegistryLike } from "@mailwoman/dev-mcp/engine/registry"
import { runLookup } from "@mailwoman/dev-mcp/lookup/tool"
import { afterAll, describe, expect, it } from "vitest"

/**
 * Fail if a source that should not use the engine registry tries to access it.
 */
const noRegistry = new Proxy({} as EngineRegistryLike, {
	get() {
		throw new Error("this source must not build an engine")
	},
})

const emptyRoot = await temporaryDirectory("mwdev-lookup-")

afterAll(() => emptyRoot[Symbol.asyncDispose]())

describe("runLookup", () => {
	it("reports a pinned candidate path BY NAME rather than as an unresolved one", async () => {
		// Preserve a missing pinned path so a typo is distinguishable from an absent gazetteer.
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
			config: { data_root: emptyRoot.path.toString() },
		})

		expect(result.rows).toEqual([])
		expect(result.unavailable_reason).toContain("poi.db")
		expect(result.notes.join(" ")).toContain("would read as absence for every query")
	})

	it("treats an unopenable WOF extract set as unavailable, not as a gazetteer with nothing in it", async () => {
		const result = await runLookup(noRegistry, {
			source: "wof",
			queries: ["Vaduz"],
			// Engine config values arrive as JSON strings.
			config: { resolve_db: emptyRoot.path("no-such-extract.db").toString() },
		})

		expect(result.rows).toEqual([])
		expect(result.unavailable_reason).toContain("No WOF extract could be opened")
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
