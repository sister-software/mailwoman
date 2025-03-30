// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Solution, SolutionMatch, Span } from "mailwoman/core"
import test from "tape"
import { OrphanedUnitTypeDeclassifier } from "./OrphanedUnitTypeDeclassifier.js"

test("UnitClassification missing: remove unit_type", (t) => {
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

	t.deepEquals(solutions.length, 1)
	t.deepEquals(solutions[0]!.matches.length, 1)
	t.deepEquals(solutions[0]!.matches[0], sp2)
	t.end()
})

test("UnitClassification present: do not remove unit_type", (t) => {
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

	t.deepEquals(solutions.length, 1)
	t.deepEquals(solutions[0]!.matches.length, 3)
	t.deepEquals(solutions[0]!.matches[0], sp1)
	t.deepEquals(solutions[0]!.matches[1], sp2)
	t.deepEquals(solutions[0]!.matches[2], sp3)
	t.end()
})
