/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The current tree satisfies the check, and each manifest disagreement the check exists to catch produces a
 *   diagnostic.
 *
 *   The two duplicate-claim branches — one locale in two families, one script in two families — are not exercised
 *   here. They read `FAMILIES` itself rather than the checkout, and `FAMILIES` is a module constant, so reaching them
 *   would mean mutating the declaration under test. The registry's own test asserts the property they guard instead.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { collectRepoContext, type RepoContext } from "@mailwoman/repo-health"
import { weightsFamilyCheck } from "@mailwoman/repo-health/checks/weights/family"
import { expect, test } from "vitest"

/**
 * A checkout holding only the `neural-weights-*` manifests this case needs, so a diagnostic
 * names the manifest the case wrote rather than one the repository happens to carry.
 *
 * The directory is moved out of this scope: the check reads it after this function returns,
 * and the returned context carries no handle a caller could dispose.
 * Each case writes a few hundred bytes under the configured temp root.
 */
async function fixtureContext(manifests: Record<string, unknown>): Promise<RepoContext> {
	const temporary = (await temporaryDirectory("weights-family-")).move()
	const trackedFiles: string[] = []

	for (const [locale, manifest] of Object.entries(manifests)) {
		await writeLocalJSONFile(manifest, temporary.path("packages", `neural-weights-${locale}`, "package.json"))

		trackedFiles.push(`packages/neural-weights-${locale}/package.json`)
	}

	return { repoRoot: temporary.path.toString(), trackedFiles }
}

/**
 * The two families as the registry declares them, which every case below starts from
 * and then breaks in one place.
 */
const LATIN_GRAPH = {
	name: "@mailwoman/neural-weights-en-us",
	files: ["model.onnx", "tokenizer.model", "model-card.json"],
}

const CJK_GRAPH = {
	name: "@mailwoman/neural-weights-cjk",
	files: ["model.onnx", "char-vocab.json", "model-card.json"],
}

const SHIPPING_LOCALES = ["en-gb", "en-au", "en-in", "en-nz", "de-de", "es-es", "fr-fr", "it-it"]

function latinOverlays(): Record<string, unknown> {
	return Object.fromEntries(
		SHIPPING_LOCALES.map((locale) => [
			locale,
			{
				name: `@mailwoman/neural-weights-${locale}`,
				files: ["model-card.json"],
				mailwoman: { baseWeights: "@mailwoman/neural-weights-en-us" },
			},
		])
	)
}

function completeTree(): Record<string, unknown> {
	return {
		"en-us": LATIN_GRAPH,
		cjk: CJK_GRAPH,
		...latinOverlays(),
		"ja-jp": {
			name: "@mailwoman/neural-weights-ja-jp",
			files: ["model-card.json", "fst-ja-jp.bin"],
			mailwoman: { baseWeights: "@mailwoman/neural-weights-cjk" },
		},
		"zh-cn": {
			name: "@mailwoman/neural-weights-zh-cn",
			files: ["model-card.json", "fst-zh-cn.bin"],
			mailwoman: { baseWeights: "@mailwoman/neural-weights-cjk" },
		},
	}
}

test("weights-family: the current tree maps every shipping package to one family", async () => {
	expect(await weightsFamilyCheck.run(await collectRepoContext())).toEqual([])
})

test("weights-family: a fixture matching the registry reports nothing", async () => {
	expect(await weightsFamilyCheck.run(await fixtureContext(completeTree()))).toEqual([])
})

test("weights-family: a graph package declaring no model.onnx is reported", async () => {
	const tree = completeTree()

	tree["en-us"] = { ...LATIN_GRAPH, files: ["tokenizer.model", "model-card.json"] }

	const diagnostics = await weightsFamilyCheck.run(await fixtureContext(tree))

	expect(diagnostics).toHaveLength(1)
	expect(diagnostics[0]?.message).toContain("declares no `model.onnx`")
	expect(diagnostics[0]?.file).toBe("packages/neural-weights-en-us/package.json")
})

test("weights-family: a char family publishing a SentencePiece vocabulary is reported", async () => {
	const tree = completeTree()

	tree.cjk = { ...CJK_GRAPH, files: ["model.onnx", "tokenizer.model", "model-card.json"] }

	const diagnostics = await weightsFamilyCheck.run(await fixtureContext(tree))

	expect(diagnostics).toHaveLength(1)
	expect(diagnostics[0]?.message).toContain("char-vocab.json")
})

test("weights-family: a shipping package no family names is reported", async () => {
	const tree = completeTree()

	tree["pt-br"] = {
		name: "@mailwoman/neural-weights-pt-br",
		files: ["model-card.json"],
		mailwoman: { baseWeights: "@mailwoman/neural-weights-en-us" },
	}

	const diagnostics = await weightsFamilyCheck.run(await fixtureContext(tree))

	expect(diagnostics).toHaveLength(1)
	expect(diagnostics[0]?.message).toContain("no family names locale `pt-br`")
})

test("weights-family: a private package no family names is admitted", async () => {
	const tree = completeTree()

	tree["base-latn"] = {
		name: "@mailwoman/neural-weights-base-latn",
		private: true,
		files: ["model.onnx", "tokenizer.model"],
	}

	expect(await weightsFamilyCheck.run(await fixtureContext(tree))).toEqual([])
})

test("weights-family: an overlay inheriting a graph its family does not name is reported", async () => {
	const tree = completeTree()

	tree["de-de"] = {
		name: "@mailwoman/neural-weights-de-de",
		files: ["model-card.json"],
		mailwoman: { baseWeights: "@mailwoman/neural-weights-cjk" },
	}

	const diagnostics = await weightsFamilyCheck.run(await fixtureContext(tree))

	expect(diagnostics).toHaveLength(1)
	expect(diagnostics[0]?.message).toContain("inherits `@mailwoman/neural-weights-cjk`")
})

test("weights-family: a family whose graph package is absent from the checkout is reported", async () => {
	const tree = completeTree()

	delete tree.cjk

	const diagnostics = await weightsFamilyCheck.run(await fixtureContext(tree))

	expect(diagnostics.some((entry) => entry.message.includes("is tracked"))).toBe(true)
})
