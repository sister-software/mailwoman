// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { effectsRegisterCheck } from "#repo-health/checks/effects-register"
import { collectRepoContext } from "#repo-health/index"

describe("effectsRegisterCheck", () => {
	// The render parses every library and tool source and formats each page.
	test("reports the committed register equal to the generator's output", { timeout: 120_000 }, async () => {
		await expect(effectsRegisterCheck.run(await collectRepoContext())).resolves.toEqual([])
	})
})
