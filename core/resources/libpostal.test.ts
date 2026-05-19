/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { LibPostalLanguageCode, LocaleIndex, generatePlurals } from "@mailwoman/core/resources"
import { expect, test } from "vitest"

function createIndexFixture<T extends Iterable<readonly [string, Iterable<LibPostalLanguageCode>]>>(
	fixtures: T
): LocaleIndex<LibPostalLanguageCode> {
	return new LocaleIndex<LibPostalLanguageCode>(fixtures, {
		displayName: "test",
	})
}

test("generatePlurals: pluralize english tokens", () => {
	const index = createIndexFixture([["cat", ["en"]]])

	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["cat", ["en"]],
		["cats", ["en"]],
	])
})

test("generatePlurals: pluralize mixed eng/xxx language tokens", () => {
	const index = createIndexFixture([["cat", ["en", "fr"]]])

	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["cat", ["en", "fr"]],
		["cats", ["en"]], // not assigned to
	])
})

test("generatePlurals: ignore non-english tokens", () => {
	const index = createIndexFixture([["cat", ["fr"]]])
	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([["cat", ["fr"]]])
})

test("generatePlurals: english - functional", () => {
	const index = createIndexFixture([
		["cat", ["en"]],
		["dog", ["en"]],
		["dogs", ["en"]], // already plural
		["fish", ["en"]], // same word singular/plural in English
	])
	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["cat", ["en"]],
		["dog", ["en"]],
		["dogs", ["en"]],
		["fish", ["en"]],
		["cats", ["en"]],
	])
})

test("generatePlurals: english - identical singular plural", () => {
	const index = createIndexFixture([
		["bison", ["en"]],
		["buffalo", ["en"]],
		["deer", ["en"]],
		["fish", ["en"]],
		["moose", ["en"]],
		["pike", ["en"]],
		["plankton", ["en"]],
		["salmon", ["en"]],
		["sheep", ["en"]],
		["swine", ["en"]],
		["trout", ["en"]],
	])

	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["bison", ["en"]],
		["buffalo", ["en"]],
		["deer", ["en"]],
		["fish", ["en"]],
		["moose", ["en"]],
		["pike", ["en"]],
		["plankton", ["en"]],
		["salmon", ["en"]],
		["sheep", ["en"]],
		["swine", ["en"]],
		["trout", ["en"]],
	])
})

test("generatePlurals: english - sibilant sound", () => {
	const index = createIndexFixture([
		["kiss", ["en"]],
		["phase", ["en"]],
		["dish", ["en"]],
		["massage", ["en"]],
		["witch", ["en"]],
		["judge", ["en"]],
	])
	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["kiss", ["en"]],
		["phase", ["en"]],
		["dish", ["en"]],
		["massage", ["en"]],
		["witch", ["en"]],
		["judge", ["en"]],

		["kisses", ["en"]],
		["phases", ["en"]],
		["dishes", ["en"]],
		["massages", ["en"]],
		["witches", ["en"]],
		["judges", ["en"]],
	])
})

test("generatePlurals: english - voiceless consonant", () => {
	const index = createIndexFixture([
		["lap", ["en"]],
		["cat", ["en"]],
		["clock", ["en"]],
		["cuff", ["en"]],
		["death", ["en"]],
	])
	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["lap", ["en"]],
		["cat", ["en"]],
		["clock", ["en"]],
		["cuff", ["en"]],
		["death", ["en"]],

		["laps", ["en"]],
		["cats", ["en"]],
		["clocks", ["en"]],
		["cuffs", ["en"]],
		["deaths", ["en"]],
	])
})

test("generatePlurals: english - regular plural", () => {
	const index = createIndexFixture([
		["boy", ["en"]],
		["girl", ["en"]],
		["chair", ["en"]],
	])
	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["boy", ["en"]],
		["girl", ["en"]],
		["chair", ["en"]],

		["boys", ["en"]],
		["girls", ["en"]],
		["chairs", ["en"]],
	])
})

test("generatePlurals: english - nouns ending in -o", () => {
	const index = createIndexFixture([
		["hero", ["en"]],
		["potato", ["en"]],
		["volcano", ["en"]],
	])
	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["hero", ["en"]],
		["potato", ["en"]],
		["volcano", ["en"]],

		["heroes", ["en"]],
		["potatoes", ["en"]],
		["volcanoes", ["en"]],
	])
})

test("generatePlurals: english - nouns ending in -o (Italian loanwords)", () => {
	const index = createIndexFixture([
		["canto", ["en"]],
		["hetero", ["en"]],
		["photo", ["en"]],
		["zero", ["en"]],
		["piano", ["en"]],
		["portico", ["en"]],
		["pro", ["en"]],
		["quarto", ["en"]],
		["kimono", ["en"]],
	])
	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["canto", ["en"]],
		["hetero", ["en"]],
		["photo", ["en"]],
		["zero", ["en"]],
		["piano", ["en"]],
		["portico", ["en"]],
		["pro", ["en"]],
		["quarto", ["en"]],
		["kimono", ["en"]],

		["cantos", ["en"]],
		["heteros", ["en"]],
		["photos", ["en"]],
		["zeros", ["en"]],
		["pianos", ["en"]],
		["porticos", ["en"]],
		["pros", ["en"]],
		["quartos", ["en"]],
		["kimonos", ["en"]],
	])
})

test("generatePlurals: english - nouns ending in -y", () => {
	const index = createIndexFixture([
		["cherry", ["en"]],
		["lady", ["en"]],
		["sky", ["en"]],
	])
	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["cherry", ["en"]],
		["lady", ["en"]],
		["sky", ["en"]],

		["cherries", ["en"]],
		["ladies", ["en"]],
		["skies", ["en"]],
	])
})

test("generatePlurals: english - nouns ending in -quy", () => {
	const index = createIndexFixture([["soliloquy", ["en"]]])
	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["soliloquy", ["en"]],

		["soliloquies", ["en"]],
	])
})

test("generatePlurals: english - voiceless fricatives", () => {
	const index = createIndexFixture([
		["bath", ["en"]],
		["mouth", ["en"]],
		["calf", ["en"]],
		["leaf", ["en"]],
		["knife", ["en"]],
		["life", ["en"]],
		["house", ["en"]],
		["moth", ["en"]],
		["proof", ["en"]],
	])
	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["bath", ["en"]],
		["mouth", ["en"]],
		["calf", ["en"]],
		["leaf", ["en"]],
		["knife", ["en"]],
		["life", ["en"]],
		["house", ["en"]],
		["moth", ["en"]],
		["proof", ["en"]],

		["baths", ["en"]],
		["mouths", ["en"]],
		["calves", ["en"]],
		["leaves", ["en"]],
		["knives", ["en"]],
		["lives", ["en"]],
		["houses", ["en"]],
		["moths", ["en"]],
		["proofs", ["en"]],
	])
})

test("generatePlurals: english - nouns ending in -f", () => {
	const index = createIndexFixture([
		["dwarf", ["en"]],
		["hoof", ["en"]],
		["elf", ["en"]],
		["turf", ["en"]],
	])

	generatePlurals(index)

	expect(index.toJSON()).toStrictEqual([
		["dwarf", ["en"]],
		["hoof", ["en"]],
		["elf", ["en"]],
		["turf", ["en"]],

		["dwarves", ["en"]],
		["hooves", ["en"]],
		["elves", ["en"]],
		["turfs", ["en"]],
	])
})
