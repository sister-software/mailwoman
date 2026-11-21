// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { declaresDataRunner } from "#repo-health/ci/data-runner"

test.each([
	["a conditional suite skip", 'describe.skipIf(!hasWOFDB)("resolver", () => {})'],
	["a conditional test run", 'test.runIf(haveModel)("parses", async () => {})'],
	["a chained modifier", 'describe.sequential.skipIf(!canRun)("cold start", () => {})'],
	["a skip on the test context", 'test("fetches", async (ctx) => {\n\tif (!live) ctx.skip("no network")\n})'],
	["a destructured skip", 'test("fetches", async ({ skip }) => {\n\tif (!live) skip()\n})'],
	["a declared runner", "// ci-runner: mailwoman-data\nimport { expect } from 'vitest'"],
])("a file with %s runs on the data runner", (_, text) => {
	expect(declaresDataRunner(text)).toBe(true)
})

test.each([
	["plain tests", 'describe("path", () => {\n\ttest("joins", () => {})\n})'],
	["a concurrent suite", 'describe.concurrent("path", () => {})'],
	["a table of cases", 'test.each([1, 2])("case %i", () => {})'],
	["a word that ends in skip", "const leadingSkip = rows.skip\nparser.noskip(1)"],
])("a file with %s runs on a hosted runner", (_, text) => {
	expect(declaresDataRunner(text)).toBe(false)
})
