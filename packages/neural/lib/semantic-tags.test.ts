/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { COMPONENT_TAGS } from "@mailwoman/codex/component"
import { describe, expect, test } from "vitest"

import { LABEL_SETS, type LabelSetName, STAGE4_FINE_TAGS } from "#labels"
import {
	headMapping,
	labelSetContract,
	ProjectionLedger,
	projectTag,
	REFINES,
	SEMANTIC_TAG_ID,
	SEMANTIC_TAG_REGISTRY_VERSION,
	SEMANTIC_TAGS,
	UNREFINED,
} from "#semantic-tags"

const NAMES = Object.keys(LABEL_SETS) as LabelSetName[]

describe("semantic tag registry", () => {
	// The values the Python trainer's `semantic_tags.py` held when the registry moved here.
	// Global ids are append-only, so these stay true as tags are added.
	test("keeps the ids, refinements and head mappings the Python registry assigned", () => {
		expect(SEMANTIC_TAG_REGISTRY_VERSION).toBe(1)

		expect(SEMANTIC_TAGS.slice(0, 33)).toEqual([
			"country",
			"region",
			"locality",
			"dependent_locality",
			"postcode",
			"subregion",
			"cedex",
			"venue",
			"street",
			"house_number",
			"street_prefix",
			"street_suffix",
			"unit",
			"po_box",
			"intersection_a",
			"intersection_b",
			"prefecture",
			"municipality",
			"district",
			"block",
			"sub_block",
			"building_number",
			"building_name",
			"locality_unit",
			"unit_designator",
			"level_designator",
			"level_id",
			"building_designator",
			"building_id",
			"entrance",
			"staircase",
			"street_prefix_particle",
			"attention",
		])

		expect(REFINES).toEqual({
			prefecture: "region",
			municipality: "locality",
			district: "dependent_locality",
			block: "house_number",
			sub_block: "house_number",
			building_number: "house_number",
		})

		expect([...UNREFINED].toSorted()).toEqual([
			"attention",
			"building_designator",
			"building_id",
			"building_name",
			"entrance",
			"level_designator",
			"level_id",
			"locality_unit",
			"staircase",
			"street_prefix_particle",
			"unit_designator",
		])

		const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

		expect(Object.fromEntries(NAMES.map((name) => [name, headMapping(name)]))).toEqual({
			stage3: range(0, 16),
			"stage3-jp": range(0, 23),
			"stage3-cn": [...range(0, 16), 23],
			"stage3-cjk": range(0, 24),
			stage4: [...range(0, 16), ...range(24, 31)],
		})
	})

	test("every fine tag is refined or declared unrefined, never both", () => {
		const fine = SEMANTIC_TAGS.filter((tag) => !(LABEL_SETS.stage3 as readonly string[]).includes(tag))

		expect(new Set(fine)).toEqual(new Set([...Object.keys(REFINES), ...UNREFINED]))
		expect(Object.keys(REFINES).filter((tag) => UNREFINED.has(tag))).toEqual([])
		expect(SEMANTIC_TAG_ID.size).toBe(SEMANTIC_TAGS.length)
	})

	test("one concept keeps its global id when its head index differs", () => {
		const cn: readonly string[] = LABEL_SETS["stage3-cn"]
		const cjk: readonly string[] = LABEL_SETS["stage3-cjk"]

		expect(cn.indexOf("locality_unit")).not.toBe(cjk.indexOf("locality_unit"))
		expect(headMapping("stage3-cn")[cn.indexOf("locality_unit")]).toBe(SEMANTIC_TAG_ID.get("locality_unit"))
		expect(headMapping("stage3-cjk")[cjk.indexOf("locality_unit")]).toBe(SEMANTIC_TAG_ID.get("locality_unit"))
	})

	test("covers the parser's component union, which lacks only the stage-4 tags", () => {
		expect(COMPONENT_TAGS.filter((tag) => !SEMANTIC_TAG_ID.has(tag))).toEqual([])

		expect(SEMANTIC_TAGS.filter((tag) => !(COMPONENT_TAGS as readonly string[]).includes(tag))).toEqual([
			...STAGE4_FINE_TAGS,
		])
	})

	test("romanized Japanese projects onto the Latin head and stays itself on the CJK head", () => {
		const romanized = ["house_number", "district", "municipality", "prefecture"]

		expect(romanized.map((tag) => projectTag(tag, "stage3"))).toEqual([
			"house_number",
			"dependent_locality",
			"locality",
			"region",
		])

		expect(romanized.map((tag) => projectTag(tag, "stage3-cjk"))).toEqual(romanized)
	})

	test("the long-form number projects to one house-number span, and two street spans stay two", () => {
		const ledger = new ProjectionLedger("stage3")

		expect(
			ledger.projectSequence([
				"B-municipality",
				"I-municipality",
				"B-block",
				"I-block",
				"B-sub_block",
				"B-building_number",
				"I-building_number",
			])
		).toEqual([
			"B-locality",
			"I-locality",
			"B-house_number",
			"I-house_number",
			"I-house_number",
			"I-house_number",
			"I-house_number",
		])

		expect(ledger.projectSequence(["B-street", "B-street"])).toEqual(["B-street", "B-street"])
	})

	test("a concept the family cannot emit is counted rather than silent", () => {
		const ledger = new ProjectionLedger("stage3")

		expect(ledger.projectSequence(["B-locality_unit", "I-locality_unit", "B-region"])).toEqual(["O", "O", "B-region"])

		const report = ledger.report()

		expect(report.unrepresentable).toEqual({ locality_unit: 2 })
		expect(report.label_set_id).toBe("stage3")
		expect(report.semantic_tag_registry_version).toBe(SEMANTIC_TAG_REGISTRY_VERSION)
	})

	test.each(NAMES)("the %s contract's head mapping follows head order", (name) => {
		const contract = labelSetContract(name)

		expect(contract.head_mapping.map((id) => SEMANTIC_TAGS[id])).toEqual(contract.head_tags)
	})
})
