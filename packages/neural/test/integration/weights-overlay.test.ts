/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The data-root overlay rung, and the artifact report that keeps it honest.
 *
 *   A weights workspace carries no `model.onnx` — the binaries are not in git — so a fresh checkout resolves
 *   the package and finds it empty. Before the overlay rung that was terminal: the package rung threw and
 *   the later rungs were unreachable, which is why a git worktree could not geocode at all.
 *
 *   The rung's own hazard is what most of this file tests. Only `model` and `tokenizer` throw; the ~11
 *   sibling artifacts resolve `existsSync → undefined` by design, so a checkout that finds the two binaries
 *   now PARSES while missing every lexicon and FST — scoring worse and saying nothing. The artifact report
 *   is the answer, and a rung that shipped without it would trade a loud failure for a quiet one.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveWeights, WeightsOrigin } from "@mailwoman/neural/weights"
import { afterEach, describe, expect, it } from "vitest"

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true })
	}
})

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "mw-weights-overlay-"))

	roots.push(root)

	return root
}

/**
 * A weights directory in the shipped layout — the same fixed filenames `resolveFromPackageDir` reads, which is exactly
 * why the overlay needs no logic of its own.
 */
function weightsDir(root: string, locale: string, files: Record<string, string>): string {
	const dir = join(root, locale)

	mkdirSync(dir, { recursive: true })

	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(dir, name), body)
	}

	return dir
}

const BINARIES = { "model.onnx": "onnx", "tokenizer.model": "sp" }

/**
 * A locale with no published package, so module resolution misses and the ladder falls through to the probes under
 * test. Using a real locale would make the result depend on whether someone had linked dev weights.
 */
const ABSENT = "xx-xx"

describe("resolveWeights — the data-root overlay rung", () => {
	it("resolves the binaries from the overlay when no package is installed", () => {
		const root = scratch()

		weightsDir(root, ABSENT, BINARIES)

		const resolved = resolveWeights({ locale: ABSENT, overlayRoot: root })

		expect(resolved.modelPath).toBe(join(root, ABSENT, "model.onnx"))
		expect(resolved.tokenizerPath).toBe(join(root, ABSENT, "tokenizer.model"))
		expect(resolved.source).toContain("overlay")
	})

	it("refuses a half-populated overlay rather than resolving one binary", () => {
		const root = scratch()

		// A tokenizer without a model is not a weaker answer, it is a broken one — and the failure it would
		// otherwise produce arrives much later, inside the ONNX session.
		weightsDir(root, ABSENT, { "tokenizer.model": "sp" })

		expect(() => resolveWeights({ locale: ABSENT, overlayRoot: root })).toThrow(/Could not resolve/)
	})

	it("falls through to the user cache when the overlay is empty", () => {
		const overlay = scratch()
		const cache = scratch()

		mkdirSync(join(overlay, ABSENT), { recursive: true })
		weightsDir(join(cache, "node_modules", "@mailwoman"), `neural-weights-${ABSENT}`, BINARIES)

		const resolved = resolveWeights({ locale: ABSENT, overlayRoot: overlay, cacheRoot: cache })

		expect(resolved.source).toContain("cache")
	})

	it("treats an explicit cache root as authoritative when nothing resolves", () => {
		const overlay = scratch()
		const cache = scratch()

		let message = ""

		try {
			resolveWeights({ locale: ABSENT, overlayRoot: overlay, cacheRoot: cache })
		} catch (error) {
			message = (error as Error).message
		}

		// An explicit candidate cache is an isolation boundary. It must name the failed cache package and must not report
		// an overlay probe, because consulting that overlay would mix installed artifacts into the candidate run.
		expect(message).toContain(cache)
		expect(message).toContain(`@mailwoman/neural-weights-${ABSENT}`)
		expect(message).not.toContain(join(overlay, ABSENT))
	})
})

describe("resolveWeights — the artifact report", () => {
	it("reports each sibling's origin, and absence as absence", () => {
		const root = scratch()

		weightsDir(root, ABSENT, { ...BINARIES, "model-card.json": "{}" })

		const { artifacts } = resolveWeights({ locale: ABSENT, overlayRoot: root })
		const by = new Map(artifacts.map((a) => [a.name, a]))

		expect(by.get("model.onnx")?.origin).toBe(WeightsOrigin.Overlay)
		expect(by.get("model-card.json")?.origin).toBe(WeightsOrigin.Overlay)

		// An artifact the overlay does not carry is reported with a null origin rather than omitted. Omitting
		// it would make "this checkout has no FST" and "this build never had an FST field" the same shape.
		const fst = by.get("fst-xx-xx.bin")

		expect(fst).toBeDefined()
		expect(fst?.origin).toBeNull()
		expect(fst?.path).toBeNull()
	})

	it("lists every known sibling, so the report's denominator is fixed", () => {
		const root = scratch()

		weightsDir(root, ABSENT, BINARIES)

		const { artifacts } = resolveWeights({ locale: ABSENT, overlayRoot: root })

		// A report whose length varied with what happened to resolve could not answer "how much am I
		// missing" — the question the rung makes newly askable.
		expect(artifacts.length).toBeGreaterThan(10)
		expect(artifacts.filter((a) => a.origin === null).length).toBeGreaterThan(0)
		expect(new Set(artifacts.map((a) => a.name)).size).toBe(artifacts.length)
	})

	it("marks explicit paths as explicit", () => {
		const root = scratch()
		const dir = weightsDir(root, ABSENT, BINARIES)

		const { artifacts } = resolveWeights({
			modelPath: join(dir, "model.onnx"),
			tokenizerPath: join(dir, "tokenizer.model"),
		})

		const model = artifacts.find((a) => a.name === "model.onnx")

		expect(model?.origin).toBe(WeightsOrigin.Explicit)
	})
})
