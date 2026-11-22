// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The weights-rights check over one planted weights package.
 *
 *   The clean tree holds what `mwops release write-rights-files` writes: the rendered `LICENSE.md` and
 *   `PROVENANCE.json` of the record the check itself reads. Each violation changes one of the three things the
 *   check compares.
 */

import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePath } from "path-ts"
import { describe, expect, it } from "vitest"

import { LICENSE_FILE, PROVENANCE_FILE, renderLicenseFile, renderProvenance } from "#release-kit/weights/rights/files"
import { weightsRightsRecords } from "#release-kit/weights/rights/write"
import { DiagnosticSeverity } from "#repo-health/check"
import { weightsRightsCheck } from "#repo-health/checks/weights/rights"
import { type FixtureRepository, plantFixtureRepository } from "#repo-health/test/fixture-repository"

const WORKSPACE = "packages/neural-weights-fixture"

/**
 * A tree with one published weights package and its generated rights files, declared in `files`.
 */
async function plantWeightsPackage(files: readonly string[]): Promise<FixtureRepository> {
	const context = await plantFixtureRepository({
		"package.json": { name: "fixture", private: true, workspaces: ["packages/*"] },
		[`${WORKSPACE}/package.json`]: {
			name: "@fixture/neural-weights-fixture",
			version: "1.0.0",
			license: "AGPL-3.0-only OR LicenseRef-Commercial",
			files,
		},
		[`${WORKSPACE}/model-card.json`]: { version: "1.2.3" },
	})

	const [record] = await weightsRightsRecords(context.repoRoot)

	await writeLocalTextFile(renderLicenseFile(record!), resolvePath(context.repoRoot, WORKSPACE, LICENSE_FILE))
	await writeLocalJSONFile(renderProvenance(record!), resolvePath(context.repoRoot, WORKSPACE, PROVENANCE_FILE))

	return context
}

const DECLARED = ["fst-fixture.bin", LICENSE_FILE, PROVENANCE_FILE]

async function errorFiles(context: FixtureRepository): Promise<Array<string | null>> {
	const diagnostics = await weightsRightsCheck.run(context)

	// A machine that can't read a model graph adds a warning, and a warning fails no package.
	return diagnostics
		.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)
		.map((diagnostic) => diagnostic.file)
}

describe("weightsRightsCheck", () => {
	it("accepts a package holding the rights files its manifest and model card generate", async () => {
		await using context = await plantWeightsPackage(DECLARED)

		await expect(errorFiles(context)).resolves.toEqual([])
	})

	it("reports a license file edited away from the generated text", async () => {
		await using context = await plantWeightsPackage(DECLARED)

		await writeLocalTextFile("# License\n\nEdited by hand.\n", resolvePath(context.repoRoot, WORKSPACE, LICENSE_FILE))

		await expect(errorFiles(context)).resolves.toEqual([`${WORKSPACE}/${LICENSE_FILE}`])
	})

	it("reports a provenance file that states another model card version", async () => {
		await using context = await plantWeightsPackage(DECLARED)

		const [record] = await weightsRightsRecords(context.repoRoot)

		await writeLocalJSONFile(
			{ ...renderProvenance(record!), model_card_version: "0.0.1" },
			resolvePath(context.repoRoot, WORKSPACE, PROVENANCE_FILE)
		)

		await expect(errorFiles(context)).resolves.toEqual([`${WORKSPACE}/${PROVENANCE_FILE}`])
	})

	it("reports a generated file the manifest leaves out of the tarball", async () => {
		await using context = await plantWeightsPackage(["fst-fixture.bin", LICENSE_FILE])

		await expect(errorFiles(context)).resolves.toEqual([`${WORKSPACE}/package.json`])
	})
})
