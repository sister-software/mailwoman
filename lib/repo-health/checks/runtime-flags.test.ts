// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import { runtimeFlagsCheck } from "#repo-health/checks/runtime-flags"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

const REGISTER = "docs/engineering/reference/runtime-flags.mdx"

/**
 * Thirty flag names, more than the size below which the check distrusts its own parse.
 */
const FLAGS = Array.from({ length: 30 }, (_, index) => `fixtureFlag${index}`)

/**
 * A register listing `flags`, and one test under `packages/` that mentions each of `covered`.
 */
function registerTree(flags: readonly string[], covered: readonly string[]) {
	return {
		[REGISTER]: [
			"| Flag | Purpose |",
			"| --- | --- |",
			...flags.map((flag) => `| \`${flag}\` | A fixture flag. |`),
			"",
		].join("\n"),
		"packages/a/lib/flags.test.ts": `export const exercised = ${stringifyJSON(covered)}\n`,
	}
}

describe("runtimeFlagsCheck", () => {
	it("reports the registered flag no test mentions", async () => {
		const [untested, ...covered] = FLAGS

		await using context = await plantFixtureRepository(registerTree(FLAGS, covered))

		const diagnostics = await runtimeFlagsCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual([REGISTER])
		expect(diagnostics[0]!.message).toContain(`${untested} `)
	})

	it("reports a register too small to be the whole register", async () => {
		const flags = FLAGS.slice(0, 3)

		await using context = await plantFixtureRepository(registerTree(flags, flags))

		const diagnostics = await runtimeFlagsCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual([REGISTER])
	})

	it("accepts a register whose flags are each mentioned by a test", async () => {
		await using context = await plantFixtureRepository(registerTree(FLAGS, FLAGS))

		await expect(runtimeFlagsCheck.run(context)).resolves.toEqual([])
	})
})
