// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Tests that a dev linker owns its overlay directory: it removes what it no longer produces,
 * and the card it leaves describes the graph it links.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readLink, statLink, tryStatLink } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { repoRootPathBuilder, workspacePathBuilder } from "@mailwoman/core/paths"
import { readReleaseConfig } from "@mailwoman/core/release-config"
import type { PathBuilder } from "path-ts"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { materializeDevOverlay } from "#weights-overlay-linker"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

let overlayRoot: PathBuilder

beforeEach(async () => {
	overlayRoot = fixtures.use(await temporaryDirectory("mw-overlay-linker-")).path
	vi.stubEnv("MAILWOMAN_WEIGHTS_OVERLAY_ROOT", overlayRoot.toString())
	vi.stubEnv("MAILWOMAN_DEV_MODEL", "")
	vi.stubEnv("MAILWOMAN_DEV_TOKENIZER", "")
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe("materializeDevOverlay — overlay ownership (#3138)", () => {
	it("removes entries it no longer produces and replaces a stale card with the workspace's", async () => {
		const overlay = overlayRoot("de-de")

		await makeDirectories(overlay)
		await writeLocalFile(`{"version": "9.1.0"}`, overlay("model-card.json"))
		await createSymbolicLink(overlayRoot("gone", "street-type-lexicon-v3.json"), overlay("street-type-lexicon-v3.json"))
		await createSymbolicLink(overlayRoot("gone", "model.onnx"), overlay("model.onnx"))
		await writeLocalFile("stale", overlay("pair-index-zz.bin"))

		await materializeDevOverlay({ locale: "de-de", model: { kind: "inherit" } })

		const card = await statLink(overlay("model-card.json"))

		expect(card.isSymbolicLink()).toBe(false)

		expect(await readLocalTextFile(overlay("model-card.json"))).toBe(
			await readLocalTextFile(workspacePathBuilder("neural-weights-de-de", "model-card.json"))
		)

		expect(await readLink(overlay("street-type-lexicon-v3.json"))).toBe(
			repoRootPathBuilder("data", "gazetteer", "street-type-lexicon-v3.json").toString()
		)

		expect(await tryStatLink(overlay("model.onnx"))).toBeNull()
		expect(await tryStatLink(overlay("pair-index-zz.bin"))).toBeNull()
	})

	it("refuses a graph its card doesn't record, leaving the overlay's pair and card in place", async () => {
		const dataRoot = fixtures.use(await temporaryDirectory("mw-overlay-linker-data-")).path

		vi.stubEnv("MAILWOMAN_DATA_ROOT", dataRoot.toString())

		const { weights } = await readReleaseConfig()

		await writeLocalFile("a graph from another release", dataRootPath(weights.model))
		await writeLocalFile("a tokenizer", dataRootPath(weights.tokenizer))

		const overlay = overlayRoot("en-us")
		const priorGraph = dataRoot("prior.onnx")

		await writeLocalFile("prior graph", priorGraph)
		await createSymbolicLink(priorGraph, overlay("model.onnx"))
		await writeLocalFile(`{"version": "prior"}`, overlay("model-card.json"))

		await expect(
			materializeDevOverlay({ locale: "en-us", model: { kind: "link", digestCard: "neural-weights-en-us" } })
		).rejects.toThrow(/#397 guard/)

		expect(await readLink(overlay("model.onnx"))).toBe(priorGraph.toString())
		expect(await readLocalTextFile(overlay("model-card.json"))).toBe(`{"version": "prior"}`)
	})
})
