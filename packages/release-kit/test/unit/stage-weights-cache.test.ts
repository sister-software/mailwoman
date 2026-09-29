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
import { stageWeightsCache } from "@mailwoman/release-kit/weights/stage-weights-cache"
import { resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * A scratch directory represented as a string.
 * `repoRoot` uses this form.
 */
async function scratchRoot(prefix: string): Promise<string> {
	return fixtures.use(await temporaryDirectory(prefix)).path.toString()
}

/**
 * Writes a package-shaped source directory with two artifacts.
 * Returns the directory path.
 */
async function sourcePackage(root: string): Promise<string> {
	const dir = resolvePath(root, "source-package")

	await makeDirectories(dir)
	await writeLocalTextFile("graph-bytes", dir, "model.onnx")
	await writeLocalTextFile(prettyJSON({ version: "1.0.0" }), dir, "model-card.json")

	return dir.toString()
}

const staged = (root: string, name: string) =>
	resolvePath(root, "cache", "node_modules", "@mailwoman", "neural-weights-en-gb", name)

describe("stageWeightsCache", () => {
	it("links each artifact by default, which writes no bytes", async () => {
		const root = await scratchRoot("stage-weights-link-")
		const from = await sourcePackage(root)

		const report = await stageWeightsCache({
			repoRoot: root,
			out: "cache",
			locale: "en-gb",
			from,
			file: [],
			omit: [],
			clean: true,
			dereference: false,
			log: () => {},
		})

		expect(report.linked).toBe(2)
		expect((await statLink(staged(root, "model.onnx"))).isSymbolicLink()).toBe(true)
	})

	it("copies each artifact's bytes under dereference, so every path stays inside the cache", async () => {
		const root = await scratchRoot("stage-weights-copy-")
		const from = await sourcePackage(root)

		const report = await stageWeightsCache({
			repoRoot: root,
			out: "cache",
			locale: "en-gb",
			from,
			file: [],
			omit: [],
			clean: true,
			dereference: true,
			log: () => {},
		})

		expect(report.linked).toBe(2)
		expect((await statLink(staged(root, "model.onnx"))).isSymbolicLink()).toBe(false)
		expect(await readLocalTextFile(staged(root, "model.onnx"))).toBe("graph-bytes")
	})

	it("leaves an omitted artifact out of the staged package", async () => {
		const root = await scratchRoot("stage-weights-omit-")
		const from = await sourcePackage(root)

		const report = await stageWeightsCache({
			repoRoot: root,
			out: "cache",
			locale: "en-gb",
			from,
			file: [],
			omit: ["model-card.json"],
			clean: true,
			dereference: true,
			log: () => {},
		})

		expect(report.linked).toBe(1)
		expect(report.omitted).toEqual(["model-card.json"])
		await expect(statLink(staged(root, "model-card.json"))).rejects.toThrow(/ENOENT/)
	})

	it("stages a file override in place of what `from` seeded", async () => {
		const root = await scratchRoot("stage-weights-file-")
		const from = await sourcePackage(root)
		const candidate = resolvePath(root, "candidate.onnx")

		await writeLocalTextFile("candidate-bytes", candidate)

		await stageWeightsCache({
			repoRoot: root,
			out: "cache",
			locale: "en-gb",
			from,
			file: [`model.onnx=${candidate}`],
			omit: [],
			clean: true,
			dereference: true,
			log: () => {},
		})

		expect(await readLocalTextFile(staged(root, "model.onnx"))).toBe("candidate-bytes")
	})
})
