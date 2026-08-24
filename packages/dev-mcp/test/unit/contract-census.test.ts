/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The contract census's denominators.
 *
 *   The tally itself is arithmetic. What is easy to get wrong is what a zero is allowed to mean: a strict dependent
 *   with no stranding count because it is never stranded, and one with no stranding count because no parse ever
 *   produced it, are the same number and opposite facts. These pin that they stay distinguishable.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { censusTrees, type ContractRow } from "@mailwoman/dev-mcp/contract-census"
import { describe, expect, it } from "vitest"

function node(tag: string, value: string, children: AddressNode[] = []): AddressNode {
	return { tag: tag as AddressNode["tag"], value, start: 0, end: value.length, confidence: 1, children }
}

function tree(roots: AddressNode[]): AddressTree {
	return { raw: "", roots, system: undefined }
}

function row(id: string, input: string, roots: AddressNode[]): ContractRow {
	return { id, input, tree: tree(roots) }
}

describe("censusTrees", () => {
	it("counts a stranded dependent against the rows that produced its tag", () => {
		const census = censusTrees([
			// `house_number` with no street anywhere: stranded.
			row("orphan", "64 , Alburgh VT", [node("house_number", "64"), node("region", "VT")]),
			// `house_number` under a street: anchored.
			row("anchored", "64 Industrial Park Rd", [node("street", "Industrial Park Rd", [node("house_number", "64")])]),
		])

		const houseNumber = census.stranding.find((entry) => entry.tag === "house_number")

		expect(houseNumber).toMatchObject({ produced_on_rows: 2, stranded: 1 })
		expect(houseNumber?.stranding_rate).toBeCloseTo(0.5, 10)
		expect(census.rows_violating).toBe(1)
	})

	it("reports a tag no parse produced as a null rate, not a zero one", () => {
		const census = censusTrees([row("plain", "Alburgh, VT", [node("locality", "Alburgh")])])
		const cedex = census.stranding.find((entry) => entry.tag === "cedex")

		expect(cedex).toMatchObject({ produced_on_rows: 0, stranded: 0 })
		expect(cedex?.stranding_rate).toBeNull()
		expect(census.never_produced).toContain("cedex")
	})

	it("enumerates every strict dependent, fired or not", () => {
		// The check's denominator is the tag set, so a class that never fires still has to appear — otherwise the
		// report is a list of what happened with no way to see what did not.
		const census = censusTrees([row("plain", "Alburgh, VT", [node("locality", "Alburgh")])])

		expect(census.stranding.map((entry) => entry.tag).toSorted()).toEqual([
			"attention",
			"cedex",
			"dependent_locality",
			"house_number",
			"street_prefix",
			"street_prefix_particle",
			"street_suffix",
			"unit",
		])
	})

	it("counts a tag once per row however many nodes carry it", () => {
		// Two stranded units on one row is one row that produced `unit`. Counting nodes would let a single pathological
		// row report broad coverage of a tag.
		const census = censusTrees([row("two", "Apt 1 Apt 2", [node("unit", "Apt 1"), node("unit", "Apt 2")])])

		expect(census.stranding.find((entry) => entry.tag === "unit")?.produced_on_rows).toBe(1)
	})

	it("says a zero illegal-edge count is the designed state rather than an unexplained zero", () => {
		const census = censusTrees([row("plain", "Alburgh, VT", [node("locality", "Alburgh")])])

		expect(census.illegal_edges.n).toBe(0)
		expect(census.illegal_edges.note).toMatch(/DESIGNED state/)
	})

	it("carries the offending address on every class it reports", () => {
		const census = censusTrees([row("orphan", "64 , Alburgh VT", [node("house_number", "64")])])

		expect(census.classes[0]?.examples[0]).toMatchObject({ id: "orphan", input: "64 , Alburgh VT", value: "64" })
	})

	it("groups duplicate tags by sibling, nested, and separate-branch topology", () => {
		const census = censusTrees([
			row("sibling", "Portopetro, Illes Balears", [node("locality", "Portopetro"), node("locality", "Illes Balears")]),
			row("nested", "St Mary's, Oxford", [node("locality", "Oxford", [node("locality", "St Mary's")])]),
			row("branches", "Aravaca, Madrid", [
				node("country", "Spain", [node("locality", "Madrid")]),
				node("region", "Community of Madrid", [node("locality", "Aravaca")]),
			]),
		])

		expect(census.duplicate_tags).toMatchObject({ rows: 3, rate: 1 })

		expect(census.duplicate_tags.topologies).toEqual([
			{ topology: "sibling", rows: 1 },
			{ topology: "nested", rows: 1 },
			{ topology: "separate-branches", rows: 1 },
		])

		expect(census.duplicate_tags.classes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tag: "locality", topology: "sibling", n: 1 }),
				expect.objectContaining({ tag: "locality", topology: "nested", n: 1 }),
				expect.objectContaining({ tag: "locality", topology: "separate-branches", n: 1 }),
			])
		)

		expect(census.duplicate_tags.classes.find((entry) => entry.topology === "sibling")?.examples[0]).toEqual({
			id: "sibling",
			input: "Portopetro, Illes Balears",
			values: ["Portopetro", "Illes Balears"],
		})
	})

	it("counts one row once per duplicate topology instead of counting node pairs", () => {
		const census = censusTrees([
			row("three", "A, B, C", [node("locality", "A"), node("locality", "B"), node("locality", "C")]),
		])

		expect(census.duplicate_tags.rows).toBe(1)

		expect(census.duplicate_tags.classes).toEqual([
			expect.objectContaining({ tag: "locality", topology: "sibling", n: 1 }),
		])
	})

	it("reports no duplicate-tag rate over an empty evaluation", () => {
		expect(censusTrees([]).duplicate_tags).toMatchObject({
			rows: 0,
			rate: null,
			topologies: [
				{ topology: "sibling", rows: 0 },
				{ topology: "nested", rows: 0 },
				{ topology: "separate-branches", rows: 0 },
			],
			classes: [],
		})
	})
})
