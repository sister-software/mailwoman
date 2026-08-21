/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Containment contract: the pre/post interval truth table (ancestor / descendant / sibling / self
 *   / disjoint), descendant range scans, the DAG primary-parent rule, declared-but-absent parents,
 *   and cycle rejection at seal.
 */

import { AncestrieBuilder } from "@mailwoman/ancestrie/builder"
import { Ancestrie } from "@mailwoman/ancestrie/reader"
import { describe, expect, it } from "vitest"

/**
 * The forest:
 *
 *     1 (a)            5 (e)
 *     ├── 2 (b)
 *     │   ├── 4 (d)
 *     │   └── 6 (f, parents [2, 3] — DAG: primary 2, secondary 3)
 *     └── 3 (c)
 */
function sealForest(): Ancestrie {
	const builder = new AncestrieBuilder()
	builder.add({ tokens: ["a"], id: 1, parentIDs: [], rank: 0.5 })
	builder.add({ tokens: ["b"], id: 2, parentIDs: [1], rank: 0.5 })
	builder.add({ tokens: ["c"], id: 3, parentIDs: [1], rank: 0.5 })
	builder.add({ tokens: ["d"], id: 4, parentIDs: [2], rank: 0.5 })
	builder.add({ tokens: ["e"], id: 5, parentIDs: [], rank: 0.5 })
	builder.add({ tokens: ["f"], id: 6, parentIDs: [2, 3], rank: 0.5 })

	return Ancestrie.from(builder.seal())
}

describe("contains — the interval truth table", () => {
	const trie = sealForest()

	it("ancestor → descendant: true, including transitively", () => {
		expect(trie.contains(1, 2)).toBe(true)
		expect(trie.contains(1, 4)).toBe(true)
		expect(trie.contains(2, 4)).toBe(true)
	})

	it("descendant → ancestor: false (direction matters)", () => {
		expect(trie.contains(2, 1)).toBe(false)
		expect(trie.contains(4, 1)).toBe(false)
		expect(trie.contains(4, 2)).toBe(false)
	})

	it("siblings: false both ways", () => {
		expect(trie.contains(2, 3)).toBe(false)
		expect(trie.contains(3, 2)).toBe(false)
	})

	it("self: an entry contains itself", () => {
		for (const id of [1, 2, 3, 4, 5, 6]) {
			expect(trie.contains(id, id)).toBe(true)
		}
	})

	it("disjoint trees: false both ways", () => {
		expect(trie.contains(1, 5)).toBe(false)
		expect(trie.contains(5, 1)).toBe(false)
		expect(trie.contains(5, 4)).toBe(false)
	})

	it("unknown ids: false, never a guess", () => {
		expect(trie.contains(999, 4)).toBe(false)
		expect(trie.contains(1, 999)).toBe(false)
	})
})

describe("descendantsOf — pre-order range scan", () => {
	const trie = sealForest()

	it("enumerates the full subtree in pre-order", () => {
		// 1's children sorted by id: [2, 3]; 2's children: [4, 6].
		expect(trie.descendantsOf(1)).toEqual([2, 4, 6, 3])
		expect(trie.descendantsOf(2)).toEqual([4, 6])
	})

	it("a leaf and a childless root have no descendants", () => {
		expect(trie.descendantsOf(4)).toEqual([])
		expect(trie.descendantsOf(5)).toEqual([])
	})

	it("an unknown id yields []", () => {
		expect(trie.descendantsOf(999)).toEqual([])
	})

	it("agrees with contains for every pair", () => {
		const ids = [1, 2, 3, 4, 5, 6]

		for (const ancestor of ids) {
			const descendants = new Set(trie.descendantsOf(ancestor))

			for (const other of ids) {
				expect(descendants.has(other)).toBe(other !== ancestor && trie.contains(ancestor, other))
			}
		}
	})
})

describe("ancestorsOf and the DAG primary-parent rule", () => {
	const trie = sealForest()

	it("walks the primary chain, nearest parent first", () => {
		expect(trie.ancestorsOf(4)).toEqual([2, 1])
		expect(trie.ancestorsOf(1)).toEqual([])
		expect(trie.ancestorsOf(999)).toEqual([])
	})

	it("a multi-parent entry is contained by its PRIMARY parent only", () => {
		expect(trie.contains(2, 6)).toBe(true)
		expect(trie.contains(3, 6)).toBe(false)
		expect(trie.ancestorsOf(6)).toEqual([2, 1])
	})

	it("the full declared parent list survives verbatim", () => {
		expect(trie.parentsOf(6)).toEqual([2, 3])
		expect(trie.parentsOf(1)).toEqual([])
		expect(trie.parentsOf(999)).toEqual([])
	})
})

describe("declared-but-absent parents", () => {
	it("an entry whose primary parent is absent becomes a forest root; the declared id survives", () => {
		const builder = new AncestrieBuilder()
		builder.add({ tokens: ["orphan"], id: 7, parentIDs: [999], rank: 0.5 })
		const trie = Ancestrie.from(builder.seal())

		// The chain includes the declared parent, then stops — it cannot be walked further.
		expect(trie.ancestorsOf(7)).toEqual([999])
		expect(trie.parentsOf(7)).toEqual([999])
		// Interval containment answers over artifact-resident entries only.
		expect(trie.contains(999, 7)).toBe(false)
		expect(trie.descendantsOf(7)).toEqual([])
	})
})

describe("cycle rejection at seal", () => {
	it("a primary-parent cycle fails the seal", () => {
		const builder = new AncestrieBuilder()
		builder.add({ tokens: ["x"], id: 1, parentIDs: [2], rank: 0.5 })
		builder.add({ tokens: ["y"], id: 2, parentIDs: [1], rank: 0.5 })

		expect(() => builder.seal()).toThrow(/primary-parent cycle/)
	})

	it("a self-parent fails the seal", () => {
		const builder = new AncestrieBuilder()
		builder.add({ tokens: ["x"], id: 1, parentIDs: [1], rank: 0.5 })

		expect(() => builder.seal()).toThrow(/primary-parent cycle/)
	})

	it("a cycle through only SECONDARY parents is fine — the interval forest never sees it", () => {
		const builder = new AncestrieBuilder()
		builder.add({ tokens: ["x"], id: 1, parentIDs: [], rank: 0.5 })
		builder.add({ tokens: ["y"], id: 2, parentIDs: [1, 3], rank: 0.5 })
		builder.add({ tokens: ["z"], id: 3, parentIDs: [1, 2], rank: 0.5 })

		expect(() => builder.seal()).not.toThrow()
	})
})
