// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { licenseRegisterCheck } from "#repo-health/checks/license-register"
import { collectRepoContext } from "#repo-health/index"

test("license-register: the committed well-known file equals the register's derivation", async () => {
	const context = await collectRepoContext()

	expect(await licenseRegisterCheck.run(context)).toEqual([])
})
