// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { cliFlagPropertiesCheck } from "#repo-health/checks/cli-flag-properties"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

const COMMAND = "packages/a/cli/commands/probe.ts"

/**
 * A component command whose one kebab flag derives the property `plantedWidth`.
 */
const COMMAND_SOURCE = [
	"export const spec = {",
	"\toptions: {",
	'\t\t"planted-width": { type: "string" },',
	"\t},",
	"} as const satisfies CommandSpec",
	"",
].join("\n")

describe("cliFlagPropertiesCheck", () => {
	it("reports a flag whose derived property no tracked source mentions", async () => {
		await using context = await plantFixtureRepository({ [COMMAND]: COMMAND_SOURCE })

		const diagnostics = await cliFlagPropertiesCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual([COMMAND])
		expect(diagnostics[0]!.message).toContain("--planted-width")
	})

	it("accepts the flag once a tracked source reads the property", async () => {
		await using context = await plantFixtureRepository({
			[COMMAND]: COMMAND_SOURCE,
			"packages/a/lib/render.ts": "export const width = (options: Options) => options.plantedWidth\n",
		})

		await expect(cliFlagPropertiesCheck.run(context)).resolves.toEqual([])
	})
})
