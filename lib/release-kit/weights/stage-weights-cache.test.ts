// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A staged root is graded as the model it names: every package reads the one staged graph, a training
 *   export's graph arrives with a card that records it, and a root missing a declared artifact is refused
 *   before it reaches `out`.
 */

import { md5Hex, sha256Hex } from "@mailwoman/core/crypto/hash"
import { readLocalJSONFile, readLocalTextFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists, statLink } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	copyFileTo,
	createSymbolicLink,
	makeDirectories,
	writeLocalJSONFile,
	writeLocalTextFile,
} from "@mailwoman/core/fs/writers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { stageWeightsCache } from "#release-kit/weights/stage-weights-cache"

type StageWeightsCacheOptions = Parameters<typeof stageWeightsCache>[0]

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const PUBLISHED_GRAPH = "published-graph-bytes"
const TOKENIZER = "tokenizer-bytes"
const BASE = "@mailwoman/neural-weights-en-us"

/**
 * The signed export fixture the provenance verifier's own tests read.
 */
const provenanceFixtures = resolvePackageDirectory("@mailwoman/license")("test", "fixtures", "product")

const { trusted_provenance_keys: trustedProvenanceKeys } = await readLocalJSONFile<{
	trusted_provenance_keys: Record<string, string>
}>(provenanceFixtures("provenance.json"))

/**
 * A checkout with the en-us graph package and the en-gb overlay, and a weights overlay root holding
 * the artifacts the workspaces don't, laid out as `copy-weights` and the dev linkers leave them.
 */
async function fixtureCheckout(): Promise<{ root: PathBuilder; options: StageWeightsCacheOptions }> {
	const root = fixtures.use(await temporaryDirectory("stage-weights-")).path
	const base = root("packages", "neural-weights-en-us")
	const overlay = root("packages", "neural-weights-en-gb")

	await writeLocalJSONFile(
		{ name: BASE, files: ["model.onnx", "tokenizer.model", "model-card.json", "README.md", "*.ts", "!*.test.ts"] },
		base("package.json")
	)

	await writeLocalJSONFile(
		{
			version: "1.0.0",
			files_md5: { "model.onnx": md5Hex(PUBLISHED_GRAPH), "tokenizer.model": md5Hex(TOKENIZER) },
			training: { recipe: "the published recipe", corpus_version: "v0.0.1" },
		},
		base("model-card.json")
	)

	await writeLocalTextFile("readme", base("README.md"))

	await writeLocalJSONFile(
		{
			name: "@mailwoman/neural-weights-en-gb",
			mailwoman: { baseWeights: BASE },
			files: ["model-card.json", "pair-index-gb.bin"],
		},
		overlay("package.json")
	)

	await writeLocalJSONFile({ version: "1.0.0" }, overlay("model-card.json"))

	await writeLocalTextFile(PUBLISHED_GRAPH, root("overlay", "en-us", "model.onnx"))
	await writeLocalTextFile(TOKENIZER, root("overlay", "en-us", "tokenizer.model"))
	await writeLocalTextFile("pairs", root("overlay", "en-gb", "pair-index-gb.bin"))
	await writeLocalTextFile("data:\n", root("recipe.yaml"))

	return {
		root,
		options: {
			repoRoot: root,
			out: "cache",
			locales: ["en-us", "en-gb"],
			file: [],
			omit: [],
			replace: false,
			overlayRoot: root("overlay"),
			trustedProvenanceKeys,
			log: () => {},
		},
	}
}

/**
 * Copies the signed export fixture into the checkout and returns its directory.
 */
async function fixtureExport(root: PathBuilder): Promise<PathBuilder> {
	const directory = root("run", "export")

	for (const name of ["model.onnx", "model.provenance.json", "CORPUS.json", "TRAINING.json"]) {
		await copyFileTo(provenanceFixtures("provenance", name), directory(name))
	}

	return directory
}

describe("stageWeightsCache", () => {
	it("gives every inheriting package the base graph, so each one resolves the same bytes", async () => {
		const { root, options } = await fixtureCheckout()
		const report = await stageWeightsCache(options)

		expect(report.card).toBe("published")
		expect(report.graph.sha256).toBe(sha256Hex(PUBLISHED_GRAPH))

		for (const staged of report.packages) {
			expect(staged.modelSHA256).toBe(report.graph.sha256)
			expect(staged.resolvedModelSHA256).toBe(report.graph.sha256)
		}

		const overlayGraph = report.packages.find((staged) => staged.locale === "en-gb")!.packageDir("model.onnx")

		// A link inside the root keeps one graph per root, and survives a move of the root.
		expect((await statLink(overlayGraph)).isSymbolicLink()).toBe(true)
		await expect(readLocalTextFile(overlayGraph)).resolves.toBe(PUBLISHED_GRAPH)

		// Every other artifact is a copy, so no file of the root depends on the checkout or the data root.
		const baseDir = report.packages.find((staged) => staged.locale === "en-us")!.packageDir

		expect((await statLink(baseDir("model.onnx"))).isSymbolicLink()).toBe(false)
		await expect(sortedGlob(root, "cache.staging-*", { onlyFiles: false })).resolves.toEqual([])
	})

	it("stages an export's graph with a card derived from the published card and the run's identity", async () => {
		const { root, options } = await fixtureCheckout()
		const exportDirectory = await fixtureExport(root)
		const candidate = await readLocalTextFile(exportDirectory("model.onnx"))

		const report = await stageWeightsCache({ ...options, exportDirectory, graph: "model.onnx", recipe: "recipe.yaml" })

		expect(report.card).toBe("derived")
		expect(report.graph.md5).toBe(md5Hex(candidate))

		const card = await readLocalJSONFile<{
			files_md5: Record<string, string>
			training: Record<string, string>
			candidate: { export: Record<string, string>; published_card: Record<string, string> }
		}>(report.packages.find((staged) => staged.locale === "en-us")!.packageDir("model-card.json"))

		expect(card.files_md5["model.onnx"]).toBe(md5Hex(candidate))
		expect(card.files_md5["tokenizer.model"]).toBe(md5Hex(TOKENIZER))
		expect(card.training["recipe"]).toBe("recipe.yaml")
		expect(card.candidate.export["run_id"]).toBe("mwrun_00112233445566778899aabb")
		expect(card.candidate.published_card["model_md5"]).toBe(md5Hex(PUBLISHED_GRAPH))

		for (const staged of report.packages) {
			expect(staged.resolvedModelSHA256).toBe(sha256Hex(candidate))
		}
	})

	it("refuses an export whose graph differs from the bytes its provenance binds", async () => {
		const { root, options } = await fixtureCheckout()
		const exportDirectory = await fixtureExport(root)

		await writeLocalTextFile("another graph", exportDirectory("model.onnx"))

		await expect(
			stageWeightsCache({ ...options, exportDirectory, graph: "model.onnx", recipe: "recipe.yaml" })
		).rejects.toThrow(/artifact_mismatch/)
	})

	it("refuses a root with a declared artifact behind a dangling link, and writes nothing at out", async () => {
		const { root, options } = await fixtureCheckout()

		// A link into a data root that moved away, as the 2026-09-19 roots' links into /mnt/playpen were.
		await createSymbolicLink(root("moved", "model.onnx"), root("overlay", "en-us", "model.onnx"))

		await expect(stageWeightsCache(options)).rejects.toThrow(/neural-weights-en-us\/model\.onnx/)
		expect(await pathExists(root("cache"))).toBe(false)
		await expect(sortedGlob(root, "cache.staging-*", { onlyFiles: false })).resolves.toEqual([])
	})

	it("refuses a candidate graph staged under a card that records another graph", async () => {
		const { root, options } = await fixtureCheckout()

		await writeLocalTextFile("candidate", root("candidate.onnx"))

		await expect(
			stageWeightsCache({
				...options,
				file: ["model.onnx=candidate.onnx"],
				card: "packages/neural-weights-en-us/model-card.json",
			})
		).rejects.toThrow(/records model\.onnx md5/)
	})

	it("refuses a graph override on a package that reads its graph from the base", async () => {
		const { root, options } = await fixtureCheckout()

		await writeLocalTextFile("candidate", root("candidate.onnx"))

		await expect(stageWeightsCache({ ...options, file: ["en-gb:model.onnx=candidate.onnx"] })).rejects.toThrow(
			/en-gb reads model\.onnx from @mailwoman\/neural-weights-en-us/
		)
	})

	it("leaves an omitted artifact out of every package, and refuses an existing root without --replace", async () => {
		const { root, options } = await fixtureCheckout()

		await makeDirectories(root("cache"))
		await expect(stageWeightsCache(options)).rejects.toThrow(/already exists/)

		const report = await stageWeightsCache({ ...options, omit: ["pair-index-gb.bin"], replace: true })
		const overlay = report.packages.find((staged) => staged.locale === "en-gb")!

		expect(overlay.omitted).toEqual(["pair-index-gb.bin"])
		expect(await pathExists(overlay.packageDir("pair-index-gb.bin"))).toBe(false)
	})
})
