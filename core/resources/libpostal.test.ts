// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { LibPostalLanguageCode, LocaleIndex, generatePlurals } from "mailwoman/core/resources"
import test from "tape"

function createIndexFixture<T extends Iterable<readonly [string, Iterable<LibPostalLanguageCode>]>>(
	fixtures: T
): LocaleIndex<LibPostalLanguageCode> {
	return new LocaleIndex<LibPostalLanguageCode>(fixtures, {
		displayName: "test",
	})
}

test("generatePlurals: pluralize english tokens", (t) => {
	const index = createIndexFixture([["cat", ["en"]]])

	generatePlurals(index)

	t.same(index.toJSON(), [
		["cat", ["en"]],
		["cats", ["en"]],
	])
	t.end()
})

test("generatePlurals: pluralize mixed eng/xxx language tokens", (t) => {
	const index = createIndexFixture([["cat", ["en", "fr"]]])

	generatePlurals(index)

	t.same(index.toJSON(), [
		["cat", ["en", "fr"]],
		["cats", ["en"]], // not assigned to
	])
	t.end()
})

test("generatePlurals: ignore non-english tokens", (t) => {
	const index = createIndexFixture([["cat", ["fr"]]])
	generatePlurals(index)

	t.same(index.toJSON(), [["cat", ["fr"]]])
	t.end()
})

test("generatePlurals: english - functional", (t) => {
	const index = createIndexFixture([
		["cat", ["en"]],
		["dog", ["en"]],
		["dogs", ["en"]], // already plural
		["fish", ["en"]], // same word singular/plural in English
	])
	generatePlurals(index)

	t.same(index.toJSON(), [
		["cat", ["en"]],
		["dog", ["en"]],
		["dogs", ["en"]],
		["fish", ["en"]],
		["cats", ["en"]],
	])
	t.end()
})

test("generatePlurals: english - identical singular plural", (t) => {
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

	t.same(index.toJSON(), [
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
	t.end()
})

test("generatePlurals: english - sibilant sound", (t) => {
	const index = createIndexFixture([
		["kiss", ["en"]],
		["phase", ["en"]],
		["dish", ["en"]],
		["massage", ["en"]],
		["witch", ["en"]],
		["judge", ["en"]],
	])
	generatePlurals(index)

	t.same(index.toJSON(), [
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
	t.end()
})

test("generatePlurals: english - voiceless consonant", (t) => {
	const index = createIndexFixture([
		["lap", ["en"]],
		["cat", ["en"]],
		["clock", ["en"]],
		["cuff", ["en"]],
		["death", ["en"]],
	])
	generatePlurals(index)

	t.same(index.toJSON(), [
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
	t.end()
})

test("generatePlurals: english - regular plural", (t) => {
	const index = createIndexFixture([
		["boy", ["en"]],
		["girl", ["en"]],
		["chair", ["en"]],
	])
	generatePlurals(index)

	t.same(index.toJSON(), [
		["boy", ["en"]],
		["girl", ["en"]],
		["chair", ["en"]],

		["boys", ["en"]],
		["girls", ["en"]],
		["chairs", ["en"]],
	])
	t.end()
})

test("generatePlurals: english - nouns ending in -o", (t) => {
	const index = createIndexFixture([
		["hero", ["en"]],
		["potato", ["en"]],
		["volcano", ["en"]],
	])
	generatePlurals(index)

	t.same(index.toJSON(), [
		["hero", ["en"]],
		["potato", ["en"]],
		["volcano", ["en"]],

		["heroes", ["en"]],
		["potatoes", ["en"]],
		["volcanoes", ["en"]],
	])
	t.end()
})

test("generatePlurals: english - nouns ending in -o (Italian loanwords)", (t) => {
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

	t.same(index.toJSON(), [
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
	t.end()
})

test("generatePlurals: english - nouns ending in -y", (t) => {
	const index = createIndexFixture([
		["cherry", ["en"]],
		["lady", ["en"]],
		["sky", ["en"]],
	])
	generatePlurals(index)

	t.same(index.toJSON(), [
		["cherry", ["en"]],
		["lady", ["en"]],
		["sky", ["en"]],

		["cherries", ["en"]],
		["ladies", ["en"]],
		["skies", ["en"]],
	])
	t.end()
})

test("generatePlurals: english - nouns ending in -quy", (t) => {
	const index = createIndexFixture([["soliloquy", ["en"]]])
	generatePlurals(index)

	t.same(index.toJSON(), [
		["soliloquy", ["en"]],

		["soliloquies", ["en"]],
	])
	t.end()
})

test("generatePlurals: english - voiceless fricatives", (t) => {
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

	t.same(index.toJSON(), [
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
	t.end()
})

test("generatePlurals: english - nouns ending in -f", (t) => {
	const index = createIndexFixture([
		["dwarf", ["en"]],
		["hoof", ["en"]],
		["elf", ["en"]],
		["turf", ["en"]],
	])

	generatePlurals(index)

	t.same(index.toJSON(), [
		["dwarf", ["en"]],
		["hoof", ["en"]],
		["elf", ["en"]],
		["turf", ["en"]],

		["dwarves", ["en"]],
		["hooves", ["en"]],
		["elves", ["en"]],
		["turfs", ["en"]],
	])
	t.end()
})
