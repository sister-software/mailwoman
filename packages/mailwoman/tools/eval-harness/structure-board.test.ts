/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { gradeStructureRow } from "#tools/eval-harness/structure-board"

const fixture = (expectTags: Record<string, string[]>) => ({
	id: "t",
	klass: "relation-pair",
	input: "pharmacy near leeds",
	expect: expectTags,
	surface: null,
	source: "test",
})

test("a structure row passes when every expected tag matches, folding case and whitespace", () => {
	const nodes = [{ tag: "locality", value: "Leeds", start: 14 }]

	expect(gradeStructureRow(fixture({ locality: ["leeds"] }), nodes).ok).toBe(true)
	expect(gradeStructureRow(fixture({ locality: ["york"] }), nodes).ok).toBe(false)
})

test("a whole-street fixture grades prefix and suffix spans as part of the street", () => {
	const nodes = [
		{ tag: "street", value: "pharmacy", start: 3 },
		{ tag: "street_suffix", value: "road", start: 12 },
	]

	const whole = { ...fixture({ street: ["pharmacy road"] }), input: "12 pharmacy road" }
	const split = { ...fixture({ street: ["pharmacy road"], street_suffix: [] }), input: "12 pharmacy road" }

	expect(gradeStructureRow(whole, nodes).ok).toBe(true)
	expect(gradeStructureRow(split, nodes).ok).toBe(false)
})

test("a tag listed empty must be absent", () => {
	const withVenue = [
		{ tag: "venue", value: "pharmacy", start: 0 },
		{ tag: "locality", value: "leeds", start: 14 },
	]

	expect(gradeStructureRow(fixture({ locality: ["leeds"], venue: [] }), withVenue).ok).toBe(false)
	expect(gradeStructureRow(fixture({ locality: ["leeds"], venue: [] }), withVenue.slice(1)).ok).toBe(true)
})
