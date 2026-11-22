// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { publishedLicenseKeys } from "@mailwoman/core/license"
import { expect, test } from "vitest"

import { licenseRegisterCheck } from "#repo-health/checks/license-register"
import { collectRepoContext } from "#repo-health/index"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

const WELL_KNOWN_FILE = "docs/static/.well-known/mailwoman/license-keys.json"

test("license-register: the committed well-known file equals the register's derivation", async () => {
	const context = await collectRepoContext()

	await expect(licenseRegisterCheck.run(context)).resolves.toEqual([])
})

test("license-register: a well-known file holding the register's derivation is accepted", async () => {
	await using context = await plantFixtureRepository({ [WELL_KNOWN_FILE]: publishedLicenseKeys() })

	await expect(licenseRegisterCheck.run(context)).resolves.toEqual([])
})

test("license-register: a well-known file that states another format is reported", async () => {
	await using context = await plantFixtureRepository({
		[WELL_KNOWN_FILE]: { ...publishedLicenseKeys(), format: "mailwoman-license-keys/0" },
	})

	const diagnostics = await licenseRegisterCheck.run(context)

	expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual([WELL_KNOWN_FILE])
})
