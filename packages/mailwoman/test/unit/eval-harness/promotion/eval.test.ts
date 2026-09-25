/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests the promotion eval's spec resolution, spec packaging and paired weights-cache guards.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalFile, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { listEvalSpecs, resolveThresholdSpecPath, runPromotionEval } from "mailwoman/eval-harness/promotion/eval/index"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * Matches a path against an npm `files` glob, where `**` spans directories and `*` stays within one.
 *
 * The package.json globs use no character classes or braces, so this subset is enough.
 */
function filesGlobMatches(pattern: string, path: string): boolean {
	const segments = pattern.split("/")
	const parts = path.split("/")

	const matchFrom = (si: number, pi: number): boolean => {
		for (let s = si, p = pi; ; s++, p++) {
			const segment = segments[s]

			if (segment === "**") {
				// `**` consumes zero or more whole path segments, so every split is tried.
				for (let skip = p; skip <= parts.length; skip++) {
					if (matchFrom(s + 1, skip)) return true
				}

				return false
			}

			if (segment === undefined) return p === parts.length

			if (p >= parts.length || !segmentMatches(segment, parts[p]!)) return false
		}
	}

	return matchFrom(0, 0)
}

/**
 * Matches one path segment against one glob segment.
 *
 * `*` matches any run of characters, and all other characters are literal.
 */
function segmentMatches(glob: string, segment: string): boolean {
	const pieces = glob.split("*")
	let at = 0

	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i]!

		if (piece === "") continue
		const found = segment.indexOf(piece, at)

		if (found === -1) return false

		// A leading literal must start at 0.
		// Later literals may start anywhere.
		if (i === 0 && found !== 0) return false
		at = found + piece.length
	}

	// A trailing literal must end the segment, so "*.json" rejects "a.json.bak".
	const last = pieces.at(-1)!

	return last === "" || segment.endsWith(last)
}

/**
 * Returns whether a package-relative `path` ships in the tarball under the given `files` patterns.
 *
 * Negated patterns apply in order.
 */
function shipsInPackage(files: string[], path: string): boolean {
	let included = false

	for (const pattern of files) {
		if (pattern.startsWith("!")) {
			if (filesGlobMatches(pattern.slice(1), path)) {
				included = false
			}
		} else if (filesGlobMatches(pattern, path)) {
			included = true
		}
	}

	return included
}

describe("listEvalSpecs", () => {
	it("finds the shipped specs", async () => {
		const specs = await listEvalSpecs()

		expect(specs.length).toBeGreaterThan(0)
		expect(specs).toContain("v5.3.0-family.json")

		for (const spec of specs) {
			expect(spec.endsWith(".json")).toBe(true)
		}
	})
})

describe("resolveThresholdSpecPath", () => {
	it("resolves a bare spec NAME — what the help advertises and what people type", async () => {
		const path = await resolveThresholdSpecPath("v5.3.0-family")

		expect(await pathExists(path)).toBe(true)
		expect(path).toContain("v5.3.0-family.json")
	})

	it("resolves a spec name that already carries .json", async () => {
		const path = await resolveThresholdSpecPath("v5.3.0-family.json")

		expect(await pathExists(path)).toBe(true)
	})

	it("resolves by basename, so legacy scripts/eval/checks/<spec>.json invocations keep working", async () => {
		const path = await resolveThresholdSpecPath("scripts/eval/checks/v5.3.0-family.json")

		expect(await pathExists(path)).toBe(true)
	})

	it("prefers a real path verbatim", async () => {
		const real = "packages/mailwoman/lib/eval-harness/specs/v5.3.0-family.json"

		expect(await resolveThresholdSpecPath(real)).toBe(real)
	})

	it("throws a USEFUL error naming the known specs, not a bare ENOENT", async () => {
		await expect(resolveThresholdSpecPath("v9.9.9-nope")).rejects.toThrow(
			/Check spec not found.*Known specs.*v5\.3\.0-family/s
		)
	})

	it("SHIPS every resolvable spec in the npm tarball — an installed CLI resolves the shorthand too (#1056)", async () => {
		// tsc does not emit the spec JSON files, so package.json `files` must include them.
		const pkg = await readPackageJSON(import.meta.url, "mailwoman")
		const { files } = pkg

		expect(files, "mailwoman/package.json declares no files array").toBeDefined()

		// The paths are package-relative.
		// The JSON files ship under `lib/`.
		for (const spec of await listEvalSpecs()) {
			const rel = `lib/eval-harness/specs/${spec}`
			expect(shipsInPackage(files!, rel), `${rel} must be covered by package.json files`).toBe(true)
		}

		// `baseline-assert.ts` reads baselines.json from the source tree in the same way.
		expect(shipsInPackage(files!, "lib/eval-harness/baselines.json")).toBe(true)
	})
})

describe("paired weights-caches (#47)", () => {
	/**
	 * Creates a fake weights cache with a model, tokenizer and model card.
	 *
	 * The int8 model's bytes contain `DynamicQuantizeLinear`, which the provenance guard scans for.
	 * The package directory comes from `weightsCachePackageDir`, the resolver's own layout function.
	 * Every guard under test exits with 2 before loading a model.
	 */
	async function stageFakeCache(kind: "fp32" | "int8", salt: string): Promise<string> {
		const root = fixtures.use(await temporaryDirectory(`check-pair-${kind}-`)).path
		const pkg = weightsCachePackageDir(root, "en-us")

		await makeDirectories(pkg)

		await writeLocalFile(
			kind === "int8" ? `fake-onnx ${salt}\nDynamicQuantizeLinear\n` : `fake-onnx ${salt}\n`,
			pkg("model.onnx")
		)

		await writeLocalTextFile("fake-tokenizer", pkg("tokenizer.model"))
		await writeLocalJSONFile({ training: { tokenizer_version: "v0.6.0-a0" } }, pkg("model-card.json"))

		return root.toString()
	}

	it("refuses --int8-weights-cache without --weights-cache", async () => {
		const int8 = await stageFakeCache("int8", "a")

		expect(await runPromotionEval({ check: "v9.0.0-base", int8WeightsCache: int8 })).toBe(2)
	})

	it("refuses --int8-weights-cache alongside the --model/--int8 flow", async () => {
		const wc = await stageFakeCache("fp32", "b")
		const int8 = await stageFakeCache("int8", "c")

		expect(
			await runPromotionEval({ check: "v9.0.0-base", weightsCache: wc, int8WeightsCache: int8, model: "x.onnx" })
		).toBe(2)
	})

	it("refuses a paired fp32 arm that carries quant nodes — the arms are swapped or mislabeled", async () => {
		const wc = await stageFakeCache("int8", "d")
		const int8 = await stageFakeCache("int8", "e")
		await using outDirDirectory = await temporaryDirectory("check-pair-out-")
		const outDir = outDirDirectory.path

		expect(await runPromotionEval({ check: "v9.0.0-base", weightsCache: wc, int8WeightsCache: int8, outDir })).toBe(2)
	})

	it("refuses a paired int8 arm with no quant nodes", async () => {
		const wc = await stageFakeCache("fp32", "f")
		const int8 = await stageFakeCache("fp32", "g")
		await using outDirDirectory = await temporaryDirectory("check-pair-out-")
		const outDir = outDirDirectory.path

		expect(await runPromotionEval({ check: "v9.0.0-base", weightsCache: wc, int8WeightsCache: int8, outDir })).toBe(2)
	})

	it("refuses byte-identical paired arms", async () => {
		const wc = await stageFakeCache("int8", "h")
		const int8 = await stageFakeCache("int8", "h")
		await using outDirDirectory = await temporaryDirectory("check-pair-out-")
		const outDir = outDirDirectory.path

		// Both arms have the same bytes, so only the MD5 identity check can reject them.
		const swapped = await runPromotionEval({ check: "v9.0.0-base", weightsCache: wc, int8WeightsCache: int8, outDir })

		expect(swapped).toBe(2)
	})
})
