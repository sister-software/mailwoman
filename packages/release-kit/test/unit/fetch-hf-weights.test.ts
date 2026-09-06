/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The Hugging Face materialization plan: a character-path family reads from its own bucket directory against its
 *   own card, and is planned only once its workspace is in the release list.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { releaseWorkspaces } from "@mailwoman/release-kit/release/stage"
import {
	hfVersionBase,
	planCharFamilyArtifacts,
	planWeightsMaterialization,
} from "@mailwoman/release-kit/weights/fetch-hf-weights"
import { resolvePath } from "path-ts"
import { describe, expect, it } from "vitest"

const repoRoot = String(repoRootPath())
const CJK = "packages/neural-weights-cjk"

/**
 * The family's card version names its bucket directory (`cjk/v<version>/`), so the pins below follow the card rather
 * than a literal a base swap would leave behind.
 */
async function cjkCardVersion(): Promise<string> {
	const card = await readLocalJSONFile<{ version: string }>(resolvePath(repoRoot, CJK, "model-card.json"))

	return card.version
}

describe("fetch-hf-weights — character-path families", () => {
	it("plans the cjk family under its own directory, verified against its own card", async () => {
		const card = await readLocalJSONFile<{ version: string; files_md5: Record<string, string> }>(
			resolvePath(repoRoot, CJK, "model-card.json")
		)

		const plans = await planCharFamilyArtifacts(repoRoot, "cjk", CJK)
		const model = plans.find((plan) => plan.filename === "model.onnx")

		expect(model?.origin).toEqual({
			kind: "hf",
			remoteName: "model.onnx",
			base: expect.stringMatching(new RegExp(String.raw`/cjk/v${card.version.replaceAll(".", "\\.")}$`, "u")),
		})

		expect(model?.expectedMD5).toBe(card.files_md5["model.onnx"])
		// The committed vocabulary and card are tracked, so nothing else is planned.
		expect(plans.map((plan) => plan.filename)).toEqual(["model.onnx"])
	})

	it("keeps the family's directory beside the Latin base's, never inside it", async () => {
		const latin = await hfVersionBase(repoRoot, "9.9.9")
		const root = latin.split("/").slice(0, -2).join("/")
		const plans = await planCharFamilyArtifacts(repoRoot, "cjk", CJK)

		expect(plans.length).toBeGreaterThan(0)

		for (const plan of plans) {
			if (plan.origin.kind !== "hf") continue

			expect(plan.origin.base).toBe(`${root}/cjk/v${await cjkCardVersion()}`)
		}
	})

	it("plans a family only when its workspace is in the release list", async () => {
		const released = new Set(await releaseWorkspaces(repoRoot))
		const plans = await planWeightsMaterialization(repoRoot, { version: "9.9.9" })
		const cjkPlanned = plans.some((plan) => plan.workspace === CJK)

		expect(cjkPlanned).toBe(released.has(CJK))
		// Every Latin plan reads from the base directory the version names.
		const latin = await hfVersionBase(repoRoot, "9.9.9")

		const family = new Set([CJK, "packages/neural-weights-ja-jp", "packages/neural-weights-zh-cn"])

		for (const plan of plans) {
			if (plan.origin.kind !== "hf") continue

			expect(plan.origin.base).toBe(
				family.has(plan.workspace) ? latin.split("/").slice(0, -2).join("/") + `/cjk/v${await cjkCardVersion()}` : latin
			)
		}
	})
})
