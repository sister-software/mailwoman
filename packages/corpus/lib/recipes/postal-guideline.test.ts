import { assertPostalGuidelineCitation } from "@mailwoman/codex/postal/guideline"
import { describe, expect, it } from "vitest"

import { DE_POSTFACH_GUIDELINE_LEG } from "#de/recipes/postfach-guideline"
import * as trainingLeaders from "#recipes/po/box/cedex/vocabulary"
import { generatePostalGuidelineRows, partitionPlaces, POSTAL_GUIDELINE_LEGS } from "#recipes/postal/guideline"
import type { PostalGuidelinePlace } from "#recipes/postal/guideline/leg"
import { defaultRecipeSource } from "#recipes/sources"
import { PO_BOX_LOCALE_TEMPLATES } from "#synthesizers/po-box"
import { defaultHoldouts, holdoutPolicyFor, splitForRow } from "#utils/split"

const SOURCE = defaultRecipeSource("synth-postal-guideline")
const SYLLABLES = ["ba", "ce", "di", "fo", "gu", "la", "me", "no", "pi", "ro", "sa", "te", "vi", "zu"]

/**
 * Invented place names, enough that the hashed holdout (one place in fifty) keeps several.
 */
const NAMES = SYLLABLES.flatMap((first) =>
	SYLLABLES.flatMap((second) =>
		SYLLABLES.map((third) => `${first[0]!.toUpperCase()}${first.slice(1)}${second}${third}`)
	)
)

const IT_HELD_LOCALITIES = holdoutPolicyFor(defaultHoldouts().IT ?? null).localities ?? []

const PLACES = new Map<string, PostalGuidelinePlace[]>([
	// `02` is the declared DE street-level holdout and `10` is not.
	[
		"DE",
		NAMES.slice(0, 60).map((locality, index) => ({
			locality,
			postcode: `${index % 2 ? "02" : "10"}${String(600 + index).padStart(3, "0")}`,
		})),
	],
	// Every odd place is a declared IT locality holdout and every even place is not.
	[
		"IT",
		NAMES.slice(0, 60).map((locality, index) => ({
			locality: (index % 2 ? IT_HELD_LOCALITIES[index % IT_HELD_LOCALITIES.length]! : locality).toUpperCase(),
			postcode: index % 2 ? "09124" : "67010",
			region: index % 2 ? "CA" : "AQ",
		})),
	],
	// `733` is a declared AU district holdout and `284` is not.
	[
		"AU",
		NAMES.slice(0, 60).map((locality, index) => ({
			locality: locality.toUpperCase(),
			postcode: index % 2 ? "7330" : "2840",
			region: index % 2 ? "TAS" : "NSW",
		})),
	],
])

const generate = (seed: number) => generatePostalGuidelineRows({ places: PLACES, count: 40, seed, source: SOURCE })

/**
 * Every PO-box leader a training recipe writes: the `invented-po-box` locale templates
 * and every leader list the `invented-po-box-cedex` vocabulary exports.
 */
const TRAINING_LEADERS: string[] = [
	...PO_BOX_LOCALE_TEMPLATES.flatMap((template) => [...template.leaders, ...(template.pmb ?? [])]),
	...Object.entries(trainingLeaders)
		.filter(([name]) => name.endsWith("_LEADERS") || /_LEADERS_/u.test(name))
		.flatMap(([, value]) => value as readonly string[]),
]

const words = (form: string) => form.toLowerCase().replaceAll(".", "").split(/\s+/u)
const startsWith = (form: readonly string[], prefix: readonly string[]) => prefix.every((word, i) => form[i] === word)

describe("postal-guideline", () => {
	it("writes the invented-postal-guideline source", () => {
		expect(SOURCE).toBe("invented-postal-guideline")
	})

	it("emits rows aligned with a po_box span", () => {
		const rows = generate(7)

		expect(rows).toHaveLength(40 * POSTAL_GUIDELINE_LEGS.length)

		for (const row of rows) {
			expect(row.source).toBe(SOURCE)
			expect(row.span_tags).toContain("po_box")
			expect(row.span_tags).toHaveLength(Object.keys(row.components).length)
		}

		expect(new Set(rows.map((row) => row.source_id)).size).toBe(rows.length)
	})

	it("names a cited rule on every row", () => {
		for (const row of generate(11)) {
			const leg = POSTAL_GUIDELINE_LEGS.find((candidate) => candidate.country === row.country)!

			expect(leg.rules.some((rule) => row.template.endsWith(`:${rule.id}`))).toBe(true)
		}

		for (const leg of POSTAL_GUIDELINE_LEGS) {
			for (const rule of leg.rules) {
				assertPostalGuidelineCitation(rule.citation, rule.id)
			}
		}
	})

	it("is deterministic for a seed and varies across seeds", () => {
		expect(generate(42)).toEqual(generate(42))
		expect(generate(42).map((row) => row.raw)).not.toEqual(generate(43).map((row) => row.raw))
	})

	it("gives every leg train rows as well as held-out rows, each on its place's split", () => {
		const rows = generate(7)

		for (const leg of POSTAL_GUIDELINE_LEGS) {
			const splits = rows.filter((row) => row.country === leg.country).map((row) => splitForRow(row))

			expect(splits.filter((split) => split === "train").length, leg.country).toBeGreaterThan(0)
			expect(splits.filter((split) => split !== "train").length, leg.country).toBeGreaterThan(0)
		}
	})

	it("divides places by the split's holdout", () => {
		const de = DE_POSTFACH_GUIDELINE_LEG
		const { train, heldOut } = partitionPlaces(de, PLACES.get(de.country)!, defaultHoldouts())

		expect(heldOut.length).toBeGreaterThan(0)
		expect(heldOut.every((place) => place.postcode.startsWith("02"))).toBe(true)
		expect(train.every((place) => !place.postcode.startsWith("02"))).toBe(true)
	})

	it("refuses a leg with no readable place", () => {
		const places = new Map([...PLACES, ["DE", []]])

		expect(() => generatePostalGuidelineRows({ places, count: 5, seed: 1, source: SOURCE })).toThrow(
			/no DE place is readable/u
		)
	})

	it("writes no designator a training recipe uses as a PO-box leader", () => {
		expect(TRAINING_LEADERS.length).toBeGreaterThan(20)

		const training = TRAINING_LEADERS.map(words)

		for (const leg of POSTAL_GUIDELINE_LEGS) {
			for (const designator of leg.designators) {
				const form = words(designator)

				for (const leader of training) {
					expect(startsWith(form, leader) || startsWith(leader, form), `${designator} ~ ${leader.join(" ")}`).toBe(
						false
					)
				}
			}
		}
	})

	it("writes on each row only a designator its leg declares", () => {
		for (const row of generate(9)) {
			const leg = POSTAL_GUIDELINE_LEGS.find((candidate) => candidate.country === row.country)!

			expect(leg.designators.some((designator) => row.components.po_box!.startsWith(designator))).toBe(true)
		}
	})
})
