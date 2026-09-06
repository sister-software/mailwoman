/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file When a Form 499 cessation date may close a relationship window.
 *
 *   `build-filer-lifecycle.test.ts` covers this through a built artifact, where an abstention reads as a `valid_to`
 *   that stayed null. These pin the decision itself, including the same-day case that neither an inverted nor an open
 *   window makes obvious.
 */

import { closeableCessationDate } from "@mailwoman/filer/sdk/build/form499-rows"
import { describe, expect, it } from "vitest"

describe("closeableCessationDate", () => {
	it("closes the window when the filer ceased after its last filing", () => {
		expect(closeableCessationDate("2026-06-01", "2026-04-01")).toBe("2026-06-01")
	})

	it("abstains when the two dates invert — the annual filing postdates the cessation", () => {
		expect(closeableCessationDate("2013-09-08", "2014-04-01")).toBeNull()
	})

	it("abstains on the same day: a half-open window closed at valid_from matches nothing at all", () => {
		expect(closeableCessationDate("2026-04-01", "2026-04-01")).toBeNull()
	})

	it("has nothing to close when the filer never ceased", () => {
		expect(closeableCessationDate(undefined, "2026-04-01")).toBeNull()
		expect(closeableCessationDate("", "2026-04-01")).toBeNull()
	})
})
