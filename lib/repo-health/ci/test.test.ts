// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { isCITestSuite, readCITestArguments, unrunTests } from "#repo-health/ci/test"

describe("readCITestArguments", () => {
	it("passes selected files to the requested root suite", () => {
		expect(readCITestArguments("fast", '["packages/core/lib/path.test.ts"]', "false")).toEqual([
			"ci:test:fast",
			"packages/core/lib/path.test.ts",
		])
	})

	it("allows an empty file list only for a full run", () => {
		expect(readCITestArguments("slow", "[]", "true")).toEqual(["ci:test:slow"])
		expect(() => readCITestArguments("slow", "[]", "false")).toThrow("A scoped slow job requires selected test files")
	})

	it("rejects malformed and non-string file lists", () => {
		expect(() => readCITestArguments("fast", "not JSON")).toThrow("Failed to parse JSON")
		expect(() => readCITestArguments("fast", "[1]")).toThrow("expected string, received number")
	})
})

it("lists each test of a report that neither passed nor failed", () => {
	const report = {
		testResults: [
			{
				name: "packages/neural/lib/classifier.integration.test.ts",
				assertionResults: [
					{ fullName: "classifier parses a street", status: "skipped" },
					{ fullName: "classifier loads its card", status: "passed" },
					{ fullName: "classifier reports a bad model", status: "failed" },
				],
			},
			{
				name: "packages/core/lib/path.integration.test.ts",
				assertionResults: [{ fullName: "path resolves a link", status: "pending" }],
			},
		],
	}

	expect(unrunTests(report)).toEqual([
		"packages/neural/lib/classifier.integration.test.ts > classifier parses a street",
		"packages/core/lib/path.integration.test.ts > path resolves a link",
	])
})

it("admits only the fast and slow suites", () => {
	expect(isCITestSuite("fast")).toBe(true)
	expect(isCITestSuite("slow")).toBe(true)
	expect(isCITestSuite("full")).toBe(false)
	expect(isCITestSuite(undefined)).toBe(false)
})
