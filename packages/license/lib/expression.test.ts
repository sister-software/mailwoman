// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { ExpressionOperator, licenseExpressionTerms, licenseWithoutException, splitAtOperators } from "#expression"

const { And, Or, With } = ExpressionOperator

describe("licenseExpressionTerms", () => {
	it("splits on AND and OR in any case, removing grouping", () => {
		expect(licenseExpressionTerms("(MIT OR Apache-2.0) and CC0-1.0", [And, Or])).toEqual([
			"MIT",
			"Apache-2.0",
			"CC0-1.0",
		])
	})

	it("reads an operator only with whitespace on both sides", () => {
		expect(licenseExpressionTerms("ANDROID-1.0 OR-LATER", [And, Or])).toEqual(["ANDROID-1.0 OR-LATER"])
		expect(licenseExpressionTerms("MIT AND", [And, Or])).toEqual(["MIT AND"])
	})

	it("resumes after a separator, so an operator right after another stays in the next term", () => {
		expect(splitAtOperators("A AND OR B", [And, Or])).toEqual(["A", "OR B"])
	})

	it("matches only ASCII letters, so a dotless i does not spell WITH", () => {
		expect(licenseWithoutException("Apache-2.0 WıTH LLVM-exception")).toBe("Apache-2.0 WıTH LLVM-exception")
		expect(licenseWithoutException("Apache-2.0 with LLVM-exception")).toBe("Apache-2.0")
	})

	it("keeps a WITH exception attached unless asked to split on it", () => {
		expect(licenseExpressionTerms("Apache-2.0 WITH LLVM-exception AND MIT", [And, Or])).toEqual([
			"Apache-2.0 WITH LLVM-exception",
			"MIT",
		])

		expect(splitAtOperators("Apache-2.0 WITH LLVM-exception", [With])).toEqual(["Apache-2.0", "LLVM-exception"])
	})

	it("reads a long whitespace run in linear time", () => {
		const hostile = `MIT${" ".repeat(200_000)}x`
		const started = performance.now()

		expect(licenseExpressionTerms(hostile, [And, Or])).toEqual([hostile])
		// The regular expression this replaced took quadratic time on the same input.
		expect(performance.now() - started).toBeLessThan(1000)
	})
})
