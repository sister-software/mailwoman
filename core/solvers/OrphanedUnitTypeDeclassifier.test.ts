/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solution, SolutionMatch, Span } from "@mailwoman/core"
import { expect, test } from "vitest"

import { OrphanedUnitTypeDeclassifier } from "./OrphanedUnitTypeDeclassifier.ts"

test("UnitClassification missing: remove unit_type", () => {
	const s1 = Span.from("A")
	s1.start = 0
	s1.end = 1

	const s2 = Span.from("B")
	s2.start = 3
	s2.end = 4

	const sp1 = new SolutionMatch(s1, "unit_designator")
	const sp2 = new SolutionMatch(s2, "street")

	const solutions = [new Solution([sp1, sp2])]

	const c = new OrphanedUnitTypeDeclassifier()
	c.solve({ solutions })

	expect(solutions.length).toStrictEqual(1)
	expect(solutions[0]!.matches.length).toStrictEqual(1)
	expect(solutions[0]!.matches[0]).toStrictEqual(sp2)
})

test("UnitClassification present: do not remove unit_type", () => {
	const s1 = Span.from("A")
	s1.start = 0
	s1.end = 1

	const s2 = Span.from("B")
	s2.start = 3
	s2.end = 4

	const s3 = Span.from("C")
	s2.start = 6
	s2.end = 7

	const sp1 = new SolutionMatch(s1, "unit_designator")
	const sp2 = new SolutionMatch(s2, "unit")
	const sp3 = new SolutionMatch(s3, "street")

	const solutions = [new Solution([sp1, sp2, sp3])]

	const c = new OrphanedUnitTypeDeclassifier()
	c.solve({ solutions })

	expect(solutions.length).toStrictEqual(1)
	expect(solutions[0]!.matches.length).toStrictEqual(3)
	expect(solutions[0]!.matches[0]).toStrictEqual(sp1)
	expect(solutions[0]!.matches[1]).toStrictEqual(sp2)
	expect(solutions[0]!.matches[2]).toStrictEqual(sp3)
})
