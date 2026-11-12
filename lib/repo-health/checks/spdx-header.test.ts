// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Tests the SPDX header check on a temporary tree holding files oxlint never reads.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import { spdxHeaderCheck } from "#repo-health/checks/spdx-header"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

describe("spdx-header", () => {
	it("reports a Rust file with the old header and accepts a CSS file with the SPDX header", async () => {
		const root = fixtures.use(await temporaryDirectory("spdx-header-check"))

		await writeLocalTextFile(
			"// @copyright Sister Software\n// @license AGPL-3.0\n// @author Teffen Ellis, et al.\n\nfn main() {}\n",
			root.path("crates/a/src/main.rs")
		)

		await writeLocalTextFile(
			"/* SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors */\n/* SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial */\n\n.a {\n}\n",
			root.path("styles/a.css")
		)

		await writeLocalTextFile("{}\n", root.path("data/a.json"))

		const diagnostics = await spdxHeaderCheck.run({
			repoRoot: root.path.toString(),
			trackedFiles: ["crates/a/src/main.rs", "styles/a.css", "data/a.json"],
		})

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual(["crates/a/src/main.rs"])
	})
})
