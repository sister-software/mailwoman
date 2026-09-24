/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What the reconciliation check refuses, exercised against a scratch tree rather than against today's packages.
 *
 *   A check asserted only on the real tree passes for as long as the tree is clean and says nothing about what it would
 *   catch. Each case here writes the disagreement it describes and asserts the message names it.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { weightsReconciliationCheck } from "@mailwoman/repo-health/checks/weights/reconciliation"
import { join } from "path-ts"
import { describe, expect, it } from "vitest"

interface Weights {
	locale: string
	version?: string
	files?: string[]
	baseWeights?: string
	card?: object
}

/**
 * A scratch repository holding only the weights workspaces a case needs.
 */
async function treeWith(packages: readonly Weights[]): Promise<{ root: string; dispose: () => Promise<void> }> {
	const directory = await temporaryDirectory("mw-reconciliation-")
	const workspaces = packages.map((weights) => `packages/neural-weights-${weights.locale}`)

	await writeLocalJSONFile({ workspaces }, join(directory.path, "package.json"))

	for (const weights of packages) {
		const workspace = join(directory.path, `packages/neural-weights-${weights.locale}`)

		await makeDirectories(workspace)

		await writeLocalJSONFile(
			{
				name: `@mailwoman/neural-weights-${weights.locale}`,
				version: weights.version ?? "10.0.0",
				license: "AGPL-3.0-only OR LicenseRef-Commercial",
				files: weights.files ?? ["model-card.json", "LICENSE.md", "PROVENANCE.json"],
				...(weights.baseWeights ? { mailwoman: { baseWeights: weights.baseWeights } } : {}),
			},
			join(workspace, "package.json")
		)

		await writeLocalJSONFile(weights.card ?? { version: "1.0.0" }, join(workspace, "model-card.json"))
	}

	return { root: directory.path.toString(), dispose: async () => void (await directory[Symbol.asyncDispose]()) }
}

const run = async (root: string) => weightsReconciliationCheck.run({ repoRoot: root, trackedFiles: [] })

describe("weightsReconciliationCheck", () => {
	it("accepts a graph package and an overlay pinned to it at the same version", async () => {
		const tree = await treeWith([
			{ locale: "en-us", files: ["model.onnx", "model-card.json"] },
			{ locale: "en-au", baseWeights: "@mailwoman/neural-weights-en-us" },
		])

		try {
			expect(await run(tree.root)).toEqual([])
		} finally {
			await tree.dispose()
		}
	})

	it("refuses a base no published package provides", async () => {
		const tree = await treeWith([{ locale: "en-au", baseWeights: "@mailwoman/neural-weights-absent" }])

		try {
			const messages = (await run(tree.root)).map((problem) => problem.message)

			expect(messages.some((message) => message.includes("which is not a published weights package"))).toBe(true)
			expect(messages.some((message) => message.includes("inherited lineage is unresolved"))).toBe(true)
		} finally {
			await tree.dispose()
		}
	})

	it("refuses an overlay pinned to a base at another version", async () => {
		// Every workspace releases in lockstep, so this means a release did not land whole,
		// and `yarn pack` freezes `workspace:*` against whichever version the sibling reads at pack time.
		const tree = await treeWith([
			{ locale: "en-us", version: "10.0.0", files: ["model.onnx", "model-card.json"] },
			{ locale: "en-au", version: "9.4.0", baseWeights: "@mailwoman/neural-weights-en-us" },
		])

		try {
			const messages = (await run(tree.root)).map((problem) => problem.message)

			expect(messages.some((message) => message.includes("every workspace releases in lockstep"))).toBe(true)
		} finally {
			await tree.dispose()
		}
	})

	it("refuses a digest recorded against an artifact the manifest stopped declaring", async () => {
		const tree = await treeWith([
			{
				locale: "en-gb",
				baseWeights: "@mailwoman/neural-weights-en-us",
				files: ["model-card.json", "pair-index-gb.bin"],
				card: { version: "9.0.0", files_md5: { "postcode-gb.bin": "abc123" } },
			},
			{ locale: "en-us", files: ["model.onnx", "model-card.json"] },
		])

		try {
			const messages = (await run(tree.root)).map((problem) => problem.message)

			expect(messages.some((message) => message.includes("records a digest for postcode-gb.bin"))).toBe(true)
		} finally {
			await tree.dispose()
		}
	})

	it("reads a $-prefixed key in files_md5 as an annotation rather than a filename", async () => {
		// The cards annotate themselves throughout with `$comment` and `$comment_661`.
		// Reading one as a file would report a defect in every card that documents what its digests cover.
		const tree = await treeWith([
			{
				locale: "en-us",
				files: ["model.onnx", "model-card.json"],
				card: { version: "9.1.0", files_md5: { $comment: "int8 quantized on Modal", "model.onnx": "abc123" } },
			},
		])

		try {
			expect(await run(tree.root)).toEqual([])
		} finally {
			await tree.dispose()
		}
	})

	it("refuses a package that declares a base and also ships its own graph", async () => {
		const tree = await treeWith([
			{ locale: "en-us", files: ["model.onnx", "model-card.json"] },
			{
				locale: "en-au",
				baseWeights: "@mailwoman/neural-weights-en-us",
				files: ["model.onnx", "model-card.json"],
			},
		])

		try {
			const messages = (await run(tree.root)).map((problem) => problem.message)

			expect(messages.some((message) => message.includes("declares a base and also ships model.onnx"))).toBe(true)
		} finally {
			await tree.dispose()
		}
	})
})
