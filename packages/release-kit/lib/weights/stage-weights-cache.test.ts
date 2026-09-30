/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A staged weights cache either links its artifacts or stores their bytes. A board-routed
 *   `mwdev_compare` arm refuses an artifact that resolves outside the cache it was given, so a cache
 *   assembled for grading stores the bytes.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { statLink } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { stageWeightsCache } from "#weights/stage-weights-cache"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * A scratch directory to stage into, as the builder every path below derives from.
 */
async function scratchRoot(prefix: string): Promise<PathBuilder> {
	return fixtures.use(await temporaryDirectory(prefix)).path
}

/**
 * Writes a package-shaped source directory with two artifacts and returns its directory.
 */
async function sourcePackage(root: PathBuilder): Promise<PathBuilder> {
	const dir = root("source-package")

	await makeDirectories(dir)
	await writeLocalTextFile("graph-bytes", dir("model.onnx"))
	await writeLocalTextFile(prettyJSON({ version: "1.0.0" }), dir("model-card.json"))

	return dir
}

/**
 * The options every case below shares.
 *
 * Each assertion reads the staged layout from the report's own `packageDir`
 * rather than rebuilding it, so neither value appears again below.
 */
const STAGE_INTO = "cache"
const STAGE_LOCALE = "en-gb"

describe("stageWeightsCache", () => {
	it("links each artifact by default, which writes no bytes", async () => {
		const root = await scratchRoot("stage-weights-link-")
		const from = await sourcePackage(root)

		const report = await stageWeightsCache({
			repoRoot: root,
			out: STAGE_INTO,
			locale: STAGE_LOCALE,
			from,
			file: [],
			omit: [],
			clean: true,
			dereference: false,
			log: () => {},
		})

		expect(report.linked).toBe(2)
		expect((await statLink(report.packageDir("model.onnx"))).isSymbolicLink()).toBe(true)
	})

	it("copies each artifact's bytes under dereference, so every path stays inside the cache", async () => {
		const root = await scratchRoot("stage-weights-copy-")
		const from = await sourcePackage(root)

		const report = await stageWeightsCache({
			repoRoot: root,
			out: STAGE_INTO,
			locale: STAGE_LOCALE,
			from,
			file: [],
			omit: [],
			clean: true,
			dereference: true,
			log: () => {},
		})

		expect(report.linked).toBe(2)
		expect((await statLink(report.packageDir("model.onnx"))).isSymbolicLink()).toBe(false)
		expect(await readLocalTextFile(report.packageDir("model.onnx"))).toBe("graph-bytes")
	})

	it("leaves an omitted artifact out of the staged package", async () => {
		const root = await scratchRoot("stage-weights-omit-")
		const from = await sourcePackage(root)

		const report = await stageWeightsCache({
			repoRoot: root,
			out: STAGE_INTO,
			locale: STAGE_LOCALE,
			from,
			file: [],
			omit: ["model-card.json"],
			clean: true,
			dereference: true,
			log: () => {},
		})

		expect(report.linked).toBe(1)
		expect(report.omitted).toEqual(["model-card.json"])
		await expect(statLink(report.packageDir("model-card.json"))).rejects.toThrow(/ENOENT/)
	})

	it("stages a file override in place of what `from` seeded", async () => {
		const root = await scratchRoot("stage-weights-file-")
		const from = await sourcePackage(root)
		const candidate = root("candidate.onnx")

		await writeLocalTextFile("candidate-bytes", candidate)

		const report = await stageWeightsCache({
			repoRoot: root,
			out: STAGE_INTO,
			locale: STAGE_LOCALE,
			// `file` entries stay strings because each one is a `<name-in-package>=<source>`
			// spec that `stageWeightsCache` splits, rather than a path on its own.
			file: [`model.onnx=${candidate}`],
			from,
			omit: [],
			clean: true,
			dereference: true,
			log: () => {},
		})

		expect(await readLocalTextFile(report.packageDir("model.onnx"))).toBe("candidate-bytes")
	})
})
