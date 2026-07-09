/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Classification } from "@mailwoman/core/classification"
import { TokenContext } from "@mailwoman/core/tokenization"
import { expect, test } from "vitest"

import { HashMapSolver } from "./HashMapSolver.ts"

/** Concrete subclass exposing the protected `generateHashMap` for direct unit testing. */
class TestSolver extends HashMapSolver {
	solve(): void {}
	build(context: TokenContext, includePrivate = false, includeEmpty = false) {
		return this.generateHashMap(context, includePrivate, includeEmpty)
	}
}

/** Tag every single-word span in the context with `classification`. */
function classifyWords(context: TokenContext, classification: Classification): number {
	let count = 0

	for (const section of context.sections) {
		for (const word of section.children) {
			word.classifications.add(classification)
			count++
		}
	}

	return count
}

test("generateHashMap groups every matching word span under its classification", () => {
	const context = new TokenContext("100 Main Street")
	const wordCount = classifyWords(context, "street")

	const map = new TestSolver().build(context)

	expect(map.has("street")).toBe(true)
	// one Solution for the classification, holding a match per word that carried it
	expect(map.get("street")!.matches.length).toBe(wordCount)
})

test("distinct classifications produce distinct Solutions", () => {
	const context = new TokenContext("100 Main Street")
	const sections = context.sections
	const words = sections.flatMap((s) => [...s.children])
	// classify the first word `house_number`, the rest `street` — both visible
	words[0]!.classifications.add("house_number")

	for (const word of words.slice(1)) {
		word.classifications.add("street")
	}

	const map = new TestSolver().build(context)

	expect([...map.keys()].sort()).toStrictEqual(["house_number", "street"])
	expect(map.get("house_number")!.matches.length).toBe(1)
	expect(map.get("street")!.matches.length).toBe(words.length - 1)
})

test("matches per classification are capped at MaxMatchesPerClassification (8)", () => {
	expect(HashMapSolver.MaxMatchesPerClassification).toBe(8)

	// 12 single-word spans, all the same classification → the Solution must not exceed the cap
	const context = new TokenContext("one two three four five six seven eight nine ten eleven twelve")
	const wordCount = classifyWords(context, "street")
	expect(wordCount).toBeGreaterThan(HashMapSolver.MaxMatchesPerClassification)

	const map = new TestSolver().build(context)

	expect(map.get("street")!.matches.length).toBe(HashMapSolver.MaxMatchesPerClassification)
})

test("includeEmpty seeds each Solution with a leading empty-span match", () => {
	const context = new TokenContext("100 Main")
	classifyWords(context, "street")

	const withoutEmpty = new TestSolver().build(context, false, false)
	const withEmpty = new TestSolver().build(context, false, true)

	// the seeded empty span is the first match and carries no text…
	expect(withEmpty.get("street")!.matches[0]!.span.body).toBe("")
	// …so the included-empty solution has exactly one more match than the plain one
	expect(withEmpty.get("street")!.matches.length).toBe(withoutEmpty.get("street")!.matches.length + 1)
})
