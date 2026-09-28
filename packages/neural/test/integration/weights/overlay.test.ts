/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests the data-root overlay rung and the artifact report that describes it. A weights workspace carries
 *   no `model.onnx`. Before the rung, a fresh checkout resolved the package and found it empty.
 *   It could not geocode.
 *
 *   Only `model` and `tokenizer` throw, while the sibling artifacts resolve
 *   `existsSync → undefined` by design, so a checkout that finds the two binaries parses while missing
 *   every lexicon and FST, scoring worse and reporting no failure. The artifact report is what keeps
 *   that from being a quiet failure.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { resolveWeights, WeightsOrigin } from "@mailwoman/neural/weights"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function scratch(): Promise<PathBuilder> {
	return fixtures.use(await temporaryDirectory("mw-weights-overlay-")).path
}

/**
 * A weights directory in the shipped layout, using the same fixed filenames
 * `resolveFromPackageDir` reads — which is why the overlay needs no logic of its own.
 */
async function weightsDir(root: PathBuilder, locale: string, files: Record<string, string>): Promise<PathBuilder> {
	const dir = root(locale)

	await makeDirectories(dir)

	for (const [name, body] of Object.entries(files)) {
		await writeLocalFile(body, dir(name))
	}

	return dir
}

const BINARIES = { "model.onnx": "onnx", "tokenizer.model": "sp" }

/**
 * A locale with no published package, so module resolution misses and the ladder
 * falls through to the probes under test.
 *
 * A real locale would depend on whether someone had linked dev weights.
 */
const ABSENT = "xx-xx"

describe("resolveWeights — the data-root overlay rung", () => {
	it("resolves the binaries from the overlay when no package is installed", async () => {
		const root = await scratch()

		await weightsDir(root, ABSENT, BINARIES)

		const resolved = await resolveWeights({ locale: ABSENT, overlayRoot: root })

		expect(resolved.modelPath).toBe(root(ABSENT, "model.onnx").toString())
		expect(resolved.tokenizerPath).toBe(root(ABSENT, "tokenizer.model").toString())
		expect(resolved.source).toContain("overlay")
	})

	it("refuses a half-populated overlay rather than resolving one binary", async () => {
		const root = await scratch()

		// A tokenizer without a model is broken.
		// Without this check, failure arrives later inside the ONNX session.
		await weightsDir(root, ABSENT, { "tokenizer.model": "sp" })

		await expect(resolveWeights({ locale: ABSENT, overlayRoot: root })).rejects.toThrow(/Could not resolve/)
	})

	it("falls through to the user cache when the overlay is empty", async () => {
		const overlay = await scratch()
		const cache = await scratch()

		await makeDirectories(overlay(ABSENT))
		await weightsDir(cache("node_modules", "@mailwoman"), `neural-weights-${ABSENT}`, BINARIES)

		const resolved = await resolveWeights({ locale: ABSENT, overlayRoot: overlay, cacheRoot: cache })

		expect(resolved.source).toContain("cache")
	})

	it("treats an explicit cache root as authoritative when nothing resolves", async () => {
		const overlay = await scratch()
		const cache = await scratch()

		let message = ""

		try {
			await resolveWeights({ locale: ABSENT, overlayRoot: overlay, cacheRoot: cache })
		} catch (error) {
			message = (error as Error).message
		}

		// An explicit candidate cache is an isolation boundary.
		// It must name the failed cache package.
		// It must omit the overlay probe so installed artifacts do not enter the candidate run.
		expect(message).toContain(cache.toString())
		expect(message).toContain(`@mailwoman/neural-weights-${ABSENT}`)
		expect(message).not.toContain(overlay(ABSENT).toString())
	})
})

describe("resolveWeights — the artifact report", () => {
	it("reports each sibling's origin, and absence as absence", async () => {
		const root = await scratch()

		await weightsDir(root, ABSENT, { ...BINARIES, "model-card.json": "{}" })

		const { artifacts } = await resolveWeights({ locale: ABSENT, overlayRoot: root })
		const by = new Map(artifacts.map((a) => [a.name, a]))

		expect(by.get("model.onnx")?.origin).toBe(WeightsOrigin.Overlay)
		expect(by.get("model-card.json")?.origin).toBe(WeightsOrigin.Overlay)

		// An artifact absent from the overlay is reported with a null origin.
		// Omitting it would make "this checkout has no FST" indistinguishable from "this build never had one".
		const fst = by.get("fst-xx-xx.bin")

		expect(fst).toBeDefined()
		expect(fst?.origin).toBeNull()
		expect(fst?.path).toBeNull()
	})

	it("lists every known sibling, so the report's denominator is fixed", async () => {
		const root = await scratch()

		await weightsDir(root, ABSENT, BINARIES)

		const { artifacts } = await resolveWeights({ locale: ABSENT, overlayRoot: root })

		// A report whose length varied with what resolved could not answer "how much am I missing".
		expect(artifacts.length).toBeGreaterThan(10)
		expect(artifacts.filter((a) => a.origin === null).length).toBeGreaterThan(0)
		expect(new Set(artifacts.map((a) => a.name)).size).toBe(artifacts.length)
	})

	it("marks explicit paths as explicit", async () => {
		const root = await scratch()
		const dir = await weightsDir(root, ABSENT, BINARIES)

		const { artifacts } = await resolveWeights({
			modelPath: dir("model.onnx"),
			tokenizerPath: dir("tokenizer.model"),
		})

		const model = artifacts.find((a) => a.name === "model.onnx")

		expect(model?.origin).toBe(WeightsOrigin.Explicit)
	})
})
