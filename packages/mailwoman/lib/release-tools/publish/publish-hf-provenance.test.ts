/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What `mailwoman release hf` refuses to upload: a model whose card records no training sources.
 *
 *   The check runs before upload starts. It refuses only when the card records no attribution.
 *   An entry without a license passes and remains a recorded gap.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import type { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { verifyTrainingProvenance } from "#release-tools/publish/hf"

async function cardWith(card: object): Promise<{ path: PathBuilder; dispose: () => Promise<void> }> {
	const directory = await temporaryDirectory("mw-hf-provenance-")
	const path = directory.path("model-card.json")

	await writeLocalJSONFile({ name: "fixture", version: "1.0.0", ...card }, path)

	return { path, dispose: async () => void (await directory[Symbol.asyncDispose]()) }
}

describe("verifyTrainingProvenance", () => {
	it("refuses a card with no training section", async () => {
		const card = await cardWith({})

		try {
			await expect(verifyTrainingProvenance(card.path)).rejects.toThrow(/records attribution at neither/)
		} finally {
			await card.dispose()
		}
	})

	it("refuses a card whose training section records an empty attribution list", async () => {
		// A card can include a full training section — corpus, recipe, hardware —
		// and still state no fact about where the rows came from.
		const card = await cardWith({
			training: { corpus_version: "v0.32.0-locality-shape", data_attribution: [] },
		})

		try {
			await expect(verifyTrainingProvenance(card.path)).rejects.toThrow(/records attribution at neither/)
		} finally {
			await card.dispose()
		}
	})

	it("reads the top-level attribution key, which the character-path card uses", async () => {
		// A control that reports a false absence blocks a release without cause.
		// The report is indistinguishable from a real absence.
		const card = await cardWith({
			attribution: [
				"Korean road-name address data (주소DB): 행정안전부, 공공누리 제1유형 (KOGL Type 1) — attribution required.",
			],
		})

		try {
			await expect(verifyTrainingProvenance(card.path)).resolves.toBeUndefined()
		} finally {
			await card.dispose()
		}
	})

	it("admits an entry that names no license, because a gap in the record is not a finding against the source", async () => {
		const card = await cardWith({
			training: {
				data_attribution: ["OpenAddresses PL — GUGiK / PRG (public, BDOT-derived): tokenizer-splice training text"],
			},
		})

		try {
			await expect(verifyTrainingProvenance(card.path)).resolves.toBeUndefined()
		} finally {
			await card.dispose()
		}
	})

	it("admits the card this repository would publish today", async () => {
		const card = repoRootPathBuilder("packages/neural-weights-en-us/model-card.json")

		await expect(verifyTrainingProvenance(card)).resolves.toBeUndefined()
	})

	it("admits the character-path card, whose six entries sit under the other spelling", async () => {
		const card = repoRootPathBuilder("packages/neural-weights-cjk/model-card.json")

		await expect(verifyTrainingProvenance(card)).resolves.toBeUndefined()
	})
})
