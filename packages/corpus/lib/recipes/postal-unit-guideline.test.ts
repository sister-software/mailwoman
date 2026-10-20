import { assertPostalGuidelineCitation } from "@mailwoman/codex/postal-guideline"
import { US_UNIT_DESIGNATOR_VARIANTS, US_UNIT_GUIDELINE_RULES } from "@mailwoman/codex/us"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { beforeAll, describe, expect, it } from "vitest"

import { GB_SUB_BUILDING_GUIDELINE_LEG } from "#gb/recipes/sub-building-guideline"
import { generatePostalGuidelineRows, heldOutPlaces } from "#recipes/postal-guideline"
import type { PostalGuidelinePlace } from "#recipes/postal-guideline/leg"
import { POSTAL_UNIT_GUIDELINE_LEGS } from "#recipes/postal-unit-guideline"
import { defaultRecipeSource } from "#recipes/sources"
import { SUBVENUE_PROMOTIONS } from "#subvenue/promotions"
import { PROPOSED_DESIGNATORS, SHIPPED_DESIGNATOR_SEED } from "#subvenue/table"
import { defaultHoldouts, splitForRow } from "#utils/split"

const SOURCE = defaultRecipeSource("synth-postal-unit-guideline")
const SYLLABLES = ["ba", "ce", "di", "fo", "gu", "la", "me", "no", "pi", "ro", "sa", "te", "vi", "zu"]

/**
 * Invented place names, enough that the hashed holdout (one place in fifty) keeps several.
 */
const NAMES = SYLLABLES.flatMap((first) =>
	SYLLABLES.flatMap((second) =>
		SYLLABLES.map((third) => `${first[0]!.toUpperCase()}${first.slice(1)}${second}${third}`)
	)
)

const PLACES = new Map<string, PostalGuidelinePlace[]>([
	// `23` is a declared FR holdout and `75` is not.
	[
		"FR",
		NAMES.slice(0, 80).map((locality, index) => ({
			locality: locality.toUpperCase(),
			postcode: `${index % 2 ? "23" : "75"}${String(100 + index).padStart(3, "0")}`,
		})),
	],
	// `TR` is a declared GB holdout and `AL` is not.
	[
		"GB",
		NAMES.slice(0, 80).map((locality, index) => ({
			locality: locality.toUpperCase(),
			postcode: `${index % 2 ? "TR" : "AL"}${1 + (index % 9)} ${1 + (index % 7)}AB`,
		})),
	],
	// `09` (Sardinia) is a declared IT holdout and `67` is not.
	[
		"IT",
		NAMES.slice(0, 80).map((locality, index) => ({
			locality,
			postcode: index % 2 ? "09124" : "67010",
			region: index % 2 ? "CA" : "AQ",
		})),
	],
	// `7` (Tasmania) is a declared AU holdout and `2` is not.
	[
		"AU",
		NAMES.slice(0, 80).map((locality, index) => ({
			locality: locality.toUpperCase(),
			postcode: index % 2 ? "7000" : "2840",
			region: index % 2 ? "TAS" : "NSW",
		})),
	],
	// `98` (Southland) is a declared NZ holdout and `79` is not.
	["NZ", NAMES.slice(0, 80).map((locality, index) => ({ locality, postcode: index % 2 ? "9810" : "7942" }))],
])

const generate = (seed: number) =>
	generatePostalGuidelineRows({ places: PLACES, legs: POSTAL_UNIT_GUIDELINE_LEGS, count: 40, seed, source: SOURCE })

/**
 * The first word of a designator form, folded for comparison to lower case without diacritics or dots.
 */
const headWord = (form: string) =>
	form.normalize("NFD").replaceAll(/\p{M}/gu, "").toLowerCase().replaceAll(".", "").split(/\s+/u)[0]!

/**
 * The string tuples `synthetic-secondary` draws its designators from, read from the Python builder.
 */
async function readSyntheticSecondaryDesignators(): Promise<string[]> {
	const source = await readLocalTextFile(
		repoRootPath("corpus-python", "src", "mailwoman_train", "corpora", "secondary.py")
	)

	const names = [
		"US_UNIT_DESIGNATORS",
		"US_LEVEL_DESIGNATORS",
		"US_BUILDING_DESIGNATORS",
		"EU_ENTRANCES",
		"EU_STAIRCASES",
	]

	const forms: string[] = []

	for (const name of names) {
		const line = new RegExp(`^${name}:.*$`, "mu").exec(source)?.[0]

		if (!line) throw new Error(`secondary.py no longer defines ${name}; update this test's reader.`)

		forms.push(...[...line.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!))
	}

	return forms
}

/**
 * Every unit, level, building, entrance and sub-venue designator a training
 * recipe draws: `spliced-unit`'s Pub 28 C2 table, `synthetic-secondary`'s lists,
 * and `spliced-sub-venue`'s designators and curated phrases.
 */
let trainingHeads: Set<string>

beforeAll(async () => {
	const forms = [
		...Object.entries(US_UNIT_DESIGNATOR_VARIANTS).flatMap(([canonical, variants]) => [canonical, ...variants]),
		...(await readSyntheticSecondaryDesignators()),
		...SHIPPED_DESIGNATOR_SEED.map((designator) => designator.id),
		...PROPOSED_DESIGNATORS.map((designator) => designator.id),
		...SUBVENUE_PROMOTIONS.map((promotion) => promotion.phrase),
	]

	trainingHeads = new Set(forms.map(headWord))
})

describe("postal-unit-guideline", () => {
	it("writes the invented-postal-unit-guideline source, apart from the PO-box rows", () => {
		expect(SOURCE).toBe("invented-postal-unit-guideline")
		expect(SOURCE).not.toBe(defaultRecipeSource("synth-postal-guideline"))
	})

	it("emits only rows the split puts in test, each with one unit span that matches its component", () => {
		const rows = generate(7)

		expect(rows).toHaveLength(40 * POSTAL_UNIT_GUIDELINE_LEGS.length)

		for (const row of rows) {
			expect(splitForRow(row)).toBe("test")
			expect(row.source).toBe(SOURCE)
			const tags = row.span_tags!
			const starts = row.span_starts!
			const ends = row.span_ends!

			expect(tags.filter((tag) => tag === "unit")).toHaveLength(1)
			expect(tags).toHaveLength(Object.keys(row.components).length)

			tags.forEach((tag, index) => {
				const text = row.raw.slice(starts[index], ends[index])

				expect(text.toLowerCase(), `${tag} in ${row.raw}`).toBe(row.components[tag]!.toLowerCase())
			})
		}

		expect(new Set(rows.map((row) => row.source_id)).size).toBe(rows.length)
	})

	it("names a cited rule on every row", () => {
		for (const row of generate(11)) {
			const leg = POSTAL_UNIT_GUIDELINE_LEGS.find((candidate) => candidate.country === row.country)!

			expect(leg.rules.some((rule) => row.template.endsWith(`:${rule.id}`))).toBe(true)
		}

		for (const leg of POSTAL_UNIT_GUIDELINE_LEGS) {
			for (const rule of leg.rules) {
				assertPostalGuidelineCitation(rule.citation, rule.id)
			}
		}
	})

	it("is deterministic for a seed and varies across seeds", () => {
		expect(generate(42)).toEqual(generate(42))
		expect(generate(42).map((row) => row.raw)).not.toEqual(generate(43).map((row) => row.raw))
	})

	it("draws skeletons only from held-out places", () => {
		const gb = GB_SUB_BUILDING_GUIDELINE_LEG
		const kept = heldOutPlaces(gb, PLACES.get(gb.country)!, defaultHoldouts())

		expect(kept.length).toBeGreaterThan(0)
		expect(kept.every((place) => place.postcode.startsWith("TR"))).toBe(true)

		for (const row of generate(3)) {
			const heldOutPrefix = { GB: "TR", FR: "23" }[row.country]

			if (heldOutPrefix) {
				expect(row.components.postcode!.startsWith(heldOutPrefix)).toBe(true)
			}
		}
	})

	it("writes on each row only a designator its leg declares", () => {
		for (const row of generate(9)) {
			const leg = POSTAL_UNIT_GUIDELINE_LEGS.find((candidate) => candidate.country === row.country)!

			expect(leg.designators.some((designator) => row.components.unit!.startsWith(designator))).toBe(true)
		}
	})

	it("writes no designator a training recipe draws", () => {
		expect(trainingHeads.size).toBeGreaterThan(30)

		for (const leg of POSTAL_UNIT_GUIDELINE_LEGS) {
			for (const designator of leg.designators) {
				expect(trainingHeads.has(headWord(designator)), `${leg.country} ${designator}`).toBe(false)
			}
		}
	})

	it("has no US leg, because training draws every Pub 28 C2 designator", () => {
		expect(POSTAL_UNIT_GUIDELINE_LEGS.map((leg) => leg.country)).not.toContain("US")

		for (const rule of US_UNIT_GUIDELINE_RULES) {
			expect(trainingHeads.has(headWord(rule.designator)), rule.designator).toBe(true)
			expect(trainingHeads.has(headWord(rule.abbreviation!)), rule.abbreviation!).toBe(true)
		}
	})
})
