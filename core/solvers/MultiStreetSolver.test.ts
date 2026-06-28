/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solution, SolutionMatch, TokenContext } from "@mailwoman/core"
import { expect, test } from "vitest"

import { MultiStreetSolver } from "./MultiStreetSolver.js"

/**
 * Helper: build a TokenContext, tag two of its words as `street`, and tag the phrase that spans both of them as
 * `multistreet`. Returns the context plus references to the tagged street spans.
 */
function buildIntersection(input: string) {
	const context = new TokenContext(input)
	const [section] = context.sections
	const children = Array.from(section!.children)

	const firstStreet = children[0]!
	const secondStreet = children[children.length - 1]!

	firstStreet.classifications.add("street")
	secondStreet.classifications.add("street")

	// The phrase covering both streets is the multistreet span.
	const multiPhrase = Array.from(section!.phrases).find((phrase) => {
		return phrase.start <= firstStreet.start && phrase.end >= secondStreet.end
	})!

	multiPhrase.classifications.add("multistreet")

	return { context, firstStreet, secondStreet }
}

test("multistreet present: clones street solution into an intersection solution", () => {
	const { context, firstStreet, secondStreet } = buildIntersection("main and 1st")

	// Seed an existing solution containing only the first street; the solver should clone it and
	// add the second street to form an intersection (a solution with two `street` matches).
	context.solutions = [new Solution([new SolutionMatch(firstStreet, "street")])]

	new MultiStreetSolver().solve(context)

	const intersection = context.solutions.find((solution) => solution.filter("street").length === 2)

	expect(intersection).toBeDefined()

	const streetValues = intersection!
		.filter("street")
		.map((m) => m.value)
		.sort()

	expect(streetValues).toStrictEqual([firstStreet.body, secondStreet.body].sort())
})

test("no multistreet classification: solutions are left unchanged", () => {
	const context = new TokenContext("main and 1st")
	const [section] = context.sections
	const children = Array.from(section!.children)

	// Two streets but NO multistreet phrase => the solver short-circuits.
	children[0]!.classifications.add("street")
	children[children.length - 1]!.classifications.add("street")

	const seeded = new Solution([new SolutionMatch(children[0]!, "street")])
	context.solutions = [seeded]

	new MultiStreetSolver().solve(context)

	expect(context.solutions.length).toStrictEqual(1)
	expect(context.solutions[0]).toStrictEqual(seeded)
})

test("fewer than two streets: no intersection solution is created", () => {
	const context = new TokenContext("main and 1st")
	const [section] = context.sections
	const children = Array.from(section!.children)

	const onlyStreet = children[0]!
	onlyStreet.classifications.add("street")

	// A multistreet phrase exists, but only one street is tagged.
	const multiPhrase = Array.from(section!.phrases).find((phrase) => {
		return phrase.start <= onlyStreet.start && phrase.end >= children[children.length - 1]!.end
	})!

	multiPhrase.classifications.add("multistreet")

	const seeded = new Solution([new SolutionMatch(onlyStreet, "street")])
	context.solutions = [seeded]

	new MultiStreetSolver().solve(context)

	// No solution should end up with two streets.
	expect(context.solutions.some((solution) => solution.filter("street").length === 2)).toStrictEqual(false)
})
