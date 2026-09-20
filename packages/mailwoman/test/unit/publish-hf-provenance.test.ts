/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What `mailwoman release hf` refuses to upload: a model whose card records no training sources.
 *
 *   Uploading to Hugging Face is publication, and the obligations attaching to a training source survive
 *   redistribution. The check runs before any byte leaves, so the question "what was this trained on" has an answer at
 *   the moment it becomes other people's problem rather than only in a later audit.
 *
 *   The fixtures pin the boundary in both directions, because a check that only refuses is as wrong as one that only
 *   admits. An entry naming no license is a gap to record and passes. A card recording nothing at all is refused.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { verifyTrainingProvenance } from "mailwoman/release-tools/publish-hf"
import { join, resolvePath } from "path-ts"
import { describe, expect, it } from "vitest"

async function cardWith(training: object | undefined): Promise<{ path: string; dispose: () => Promise<void> }> {
	const directory = await temporaryDirectory("mw-hf-provenance-")
	const path = join(directory.path, "model-card.json")

	await writeLocalJSONFile({ name: "fixture", version: "1.0.0", ...(training ? { training } : {}) }, path)

	return { path: String(path), dispose: async () => void (await directory[Symbol.asyncDispose]()) }
}

describe("verifyTrainingProvenance", () => {
	it("refuses a card with no training section", async () => {
		const card = await cardWith(undefined)

		try {
			await expect(verifyTrainingProvenance(card.path)).rejects.toThrow(/records no training.data_attribution/)
		} finally {
			await card.dispose()
		}
	})

	it("refuses a card whose training section records an empty attribution list", async () => {
		// The distinction this pins: a card can carry a full training section — corpus, recipe, hardware — and still
		// state nothing about where the rows came from. `neural-weights-cjk` is in exactly that state.
		const card = await cardWith({ corpus_version: "v0.32.0-locality-shape", data_attribution: [] })

		try {
			await expect(verifyTrainingProvenance(card.path)).rejects.toThrow(/records no training.data_attribution/)
		} finally {
			await card.dispose()
		}
	})

	it("admits an entry that names no license, because a gap in the record is not a finding against the source", async () => {
		const card = await cardWith({
			data_attribution: ["OpenAddresses PL — GUGiK / PRG (public, BDOT-derived): tokenizer-splice training text"],
		})

		try {
			await expect(verifyTrainingProvenance(card.path)).resolves.toBeUndefined()
		} finally {
			await card.dispose()
		}
	})

	it("admits the card this repository would publish today", async () => {
		const card = resolvePath(repoRootPath(), "packages/neural-weights-en-us/model-card.json")

		await expect(verifyTrainingProvenance(String(card))).resolves.toBeUndefined()
	})

	it("refuses the character-path card, which records its corpus and none of its sources", async () => {
		const card = resolvePath(repoRootPath(), "packages/neural-weights-cjk/model-card.json")

		await expect(verifyTrainingProvenance(String(card))).rejects.toThrow(/records no training.data_attribution/)
	})
})
