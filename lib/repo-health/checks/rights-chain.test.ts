// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { rightsChainCheck } from "#repo-health/checks/rights-chain"
import { type FixtureFiles, plantFixtureRepository } from "#repo-health/test/fixture-repository"

const GRANT = "Copyright Sister Software. The licensor grants the rights below.\n"

const DOCUMENTS: FixtureFiles = {
	"LICENSE.md": GRANT,
	"COMMERCIAL-LICENSE.md": GRANT,
	"CONTRIBUTING.md": GRANT,
	"docs/src/pages/license.mdx": GRANT,
	"docs/src/pages/license/terms/commercial-2026-10.mdx": GRANT,
	"docs/src/pages/license/terms/commercial-2026-11.mdx": GRANT,
	"docs/src/pages/license/terms/commercial-training-2026-11.mdx": GRANT,
}

describe("rightsChainCheck", () => {
	it("reports a rights document that leaves the licensor out", async () => {
		await using context = await plantFixtureRepository({
			...DOCUMENTS,
			"CONTRIBUTING.md": "A contributor grants the project the right to sublicense.\n",
		})

		const diagnostics = await rightsChainCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual(["CONTRIBUTING.md"])
	})

	it("reports a rights document that is absent", async () => {
		const { "COMMERCIAL-LICENSE.md": _absent, ...present } = DOCUMENTS

		await using context = await plantFixtureRepository(present)

		const diagnostics = await rightsChainCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual(["COMMERCIAL-LICENSE.md"])
	})

	it("accepts a tree whose rights documents all state the licensor", async () => {
		await using context = await plantFixtureRepository(DOCUMENTS)

		await expect(rightsChainCheck.run(context)).resolves.toEqual([])
	})
})
