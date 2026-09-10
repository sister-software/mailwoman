/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file `@mailwoman/core/strings/case` and `spliterator`'s casing module hold the same four helpers, because this file's
 *   copy was forked from that one. Two copies of a function do not stay equal on their own: the fork received a fix on
 *   2026-06-25 (`7c6eaf34e`, the dotted-acronym branch reading `name` instead of `normalizedName`) that upstream did not
 *   carry for eleven weeks.
 *
 *   THIS PINS THE AGREEMENT rather than the constants, which is the only thing that catches a divergence: the two are
 *   separately maintained, and a reader comparing them by eye finds them identical every time.
 *
 *   Neither copy can simply be deleted. `@mailwoman/core`'s carries four helpers spliterator does not — `pyIsUpper`,
 *   `pyTitle`, `titlecaseIfUpper`, `sentenceCaseSnake` — and `@mailwoman/core` is a dependency of packages that must not
 *   grow one on a CSV reader. When the shared four are the only ones left, collapse them.
 */

import { isUniformlyCased, smartCamelCase, smartCapitalCase, smartSnakeCase } from "@mailwoman/core/strings/case"
import {
	isUniformlyCased as upstreamIsUniformlyCased,
	smartCamelCase as upstreamSmartCamelCase,
	smartCapitalCase as upstreamSmartCapitalCase,
	smartSnakeCase as upstreamSmartSnakeCase,
} from "spliterator"
import { describe, expect, it } from "vitest"

/**
 * Inputs that separate the two implementations' branches: a caseless script, a dotted acronym, an all-caps column, a
 * spaced name, a camel name, and a name carrying characters that cannot be part of a key.
 */
const INPUTS = [
	"영업상태명",
	"所在地",
	"U.S.A.",
	"LON",
	"NUMBER",
	"First Name",
	"firstName",
	"street-name",
	"좌표정보(X)",
	"HouseNumber",
]

describe("casing parity with spliterator", () => {
	it.each(INPUTS)("smartSnakeCase agrees on %s", (input) => {
		expect(smartSnakeCase(input)).toBe(upstreamSmartSnakeCase(input))
	})

	it.each(INPUTS)("smartCamelCase agrees on %s", (input) => {
		expect(smartCamelCase(input)).toBe(upstreamSmartCamelCase(input))
	})

	it.each(INPUTS)("smartCapitalCase agrees on %s", (input) => {
		expect(smartCapitalCase(input)).toBe(upstreamSmartCapitalCase(input))
	})

	it.each(INPUTS)("isUniformlyCased agrees on %s", (input) => {
		expect(isUniformlyCased(input)).toBe(upstreamIsUniformlyCased(input))
	})
})
