/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createUnionFind } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

describe("createUnionFind", () => {
	it("an unseen key is its own set", () => {
		const sets = createUnionFind()

		expect(sets.find("solo")).toBe("solo")
	})

	it("union joins transitively", () => {
		const sets = createUnionFind()

		sets.union("a", "b")
		sets.union("c", "d")
		expect(sets.find("a")).not.toBe(sets.find("c"))

		sets.union("b", "c")
		expect(sets.find("a")).toBe(sets.find("d"))
	})

	it("a chain as long as the input does not overflow the stack", () => {
		const sets = createUnionFind()
		const length = 200_000

		for (let index = 1; index < length; index++) {
			sets.union(String(index - 1), String(index))
		}

		expect(sets.find("0")).toBe(sets.find(String(length - 1)))
	})
})
