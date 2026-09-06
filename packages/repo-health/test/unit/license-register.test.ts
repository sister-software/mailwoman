// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { collectRepoContext } from "@mailwoman/repo-health"
import { licenseRegisterCheck } from "@mailwoman/repo-health/checks/license-register"
import { expect, test } from "vitest"

test("license-register: the committed well-known file equals the register's derivation", async () => {
	const context = await collectRepoContext()

	expect(await licenseRegisterCheck.run(context)).toEqual([])
})
