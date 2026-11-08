/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the weights-materialization check against scratch workspaces.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { DiagnosticSeverity } from "#repo-health/check"
import { weightsMaterializationCheck } from "#repo-health/checks/weights/materialization"

const WORKSPACE = "packages/neural-weights-en-us"

const DECLARED = ["model-card.json", "model.onnx", "tokenizer.model", "fst-en-us.bin", "*.ts", "!scripts/**"]

/**
 * Runs the check over one workspace whose manifest and model card are tracked
 * and whose `present` files exist on disk.
 */
async function runWith(present: readonly string[]) {
	await using directory = await temporaryDirectory("weights-materialization-")

	await writeLocalJSONFile(
		{ name: "@mailwoman/neural-weights-en-us", files: DECLARED },
		directory.path(WORKSPACE, "package.json")
	)

	await writeLocalJSONFile({ version: "1.0.0" }, directory.path(WORKSPACE, "model-card.json"))

	for (const file of present) {
		await writeLocalFile("artifact", directory.path(WORKSPACE, file))
	}

	return await weightsMaterializationCheck.run({
		repoRoot: directory.path.toString(),
		trackedFiles: [`${WORKSPACE}/package.json`, `${WORKSPACE}/model-card.json`],
	})
}

describe("weightsMaterializationCheck", () => {
	it("accepts a bare workspace, which defers to the data-root overlay", async () => {
		await expect(runWith([])).resolves.toEqual([])
	})

	it("accepts a workspace holding every untracked declared artifact", async () => {
		await expect(runWith(["model.onnx", "tokenizer.model", "fst-en-us.bin"])).resolves.toEqual([])
	})

	it("refuses a workspace holding part of its untracked declared artifacts and names the absent ones", async () => {
		const diagnostics = await runWith(["model.onnx", "tokenizer.model"])

		expect(diagnostics).toHaveLength(1)

		expect(diagnostics[0]).toMatchObject({
			severity: DiagnosticSeverity.Error,
			file: `${WORKSPACE}/package.json`,
			details: ["fst-en-us.bin"],
		})

		expect(diagnostics[0]?.message).toContain("holds 2 of the 3 untracked artifacts")
	})
})
