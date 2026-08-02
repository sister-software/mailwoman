/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The derived-weights store's content key.
 *
 *   The 2026-08-02 currency-filter incident is why this has its own test: the workflow cache key
 *   hashed `release.config.json` + `data/gazetteer/*` only, so a change to the EXTRACTOR produced new
 *   artifacts while the cache served the old ones, and the pair-index↔card parity guard failed with
 *   `expected 47878 to be 49033`. A key that omits the code generating the cached thing is a
 *   stale-artifact machine.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	DERIVED_WEIGHTS_INPUTS,
	type DerivedWeightsInput,
	derivedWeightsDir,
	derivedWeightsKey,
	derivedWeightsKeyFrom,
} from "./derived-weights-key.ts"

/**
 * Name an absolute path by its basename — the shape production uses (repo-relative name, absolute read path).
 */
function at(path: string, name?: string): DerivedWeightsInput {
	return { name: name ?? path.slice(path.lastIndexOf("/") + 1), path }
}

let scratch: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "derived-weights-key-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true })
})

describe("derivedWeightsKeyFrom", () => {
	it("is stable for identical inputs", async () => {
		const a = join(scratch, "a.json")
		await writeFile(a, '{"x":1}')

		expect(derivedWeightsKeyFrom([at(a)])).toBe(derivedWeightsKeyFrom([at(a)]))
	})

	it("changes when a hashed input's CONTENT changes", async () => {
		const a = join(scratch, "a.json")
		await writeFile(a, '{"x":1}')
		const before = derivedWeightsKeyFrom([at(a)])

		await writeFile(a, '{"x":2}')

		expect(derivedWeightsKeyFrom([at(a)])).not.toBe(before)
	})

	it("changes when a GENERATING MODULE changes — the currency-filter regression", async () => {
		const config = join(scratch, "release.config.json")
		const generator = join(scratch, "pair-index.tsx")
		await writeFile(config, '{"weights":{"model":"m.onnx"}}')
		await writeFile(generator, "export const delta = 1")
		const before = derivedWeightsKeyFrom([at(config), at(generator)])

		// The config is untouched; only the code that produces the binaries changed.
		await writeFile(generator, "export const delta = 2")

		expect(derivedWeightsKeyFrom([at(config), at(generator)])).not.toBe(before)
	})

	it("is order-independent across the input list", async () => {
		const a = join(scratch, "a.json")
		const b = join(scratch, "b.json")
		await writeFile(a, "1")
		await writeFile(b, "2")

		expect(derivedWeightsKeyFrom([at(a), at(b)])).toBe(derivedWeightsKeyFrom([at(b), at(a)]))
	})

	it("treats a MISSING input as a distinct state, not as empty", async () => {
		const a = join(scratch, "a.json")
		await writeFile(a, "1")
		const present = derivedWeightsKeyFrom([at(a)])

		await rm(a)
		const absent = derivedWeightsKeyFrom([at(a)])

		const empty = join(scratch, "empty.json")
		await writeFile(empty, "")

		// Absence is not zero: a file that is gone must not hash like a file that is empty.
		expect(absent).not.toBe(present)
		expect(absent).not.toBe(derivedWeightsKeyFrom([at(empty)]))
	})

	it("distinguishes inputs by NAME", async () => {
		const a = join(scratch, "a.json")
		const b = join(scratch, "b.json")
		await writeFile(a, "same")
		await writeFile(b, "same")

		// Renaming an input is a change, even when the bytes are identical.
		expect(derivedWeightsKeyFrom([at(a)])).not.toBe(derivedWeightsKeyFrom([at(b)]))
	})

	it("is INVARIANT to checkout location — the whole point of a shared store", async () => {
		// The first version hashed absolute paths. Every runner checks out to its own work directory,
		// so lab-1, lab-2, lab-3 and a local worktree each computed a different key over byte-identical
		// inputs and none ever saw another's work: four store directories holding the same eleven
		// artifacts, and a 41s pair-index-nz.bin rebuild on a runner that already had the file.
		const checkoutA = join(scratch, "runner-1", "_work", "mailwoman")
		const checkoutB = join(scratch, "runner-2", "_work", "mailwoman")

		for (const root of [checkoutA, checkoutB]) {
			await mkdir(root, { recursive: true })
			await writeFile(join(root, "release.config.json"), '{"weights":{"model":"m.onnx"}}')
			await writeFile(join(root, "pair-index.tsx"), "export const delta = 10")
		}

		const inputsFor = (root: string) => [
			at(join(root, "release.config.json"), "release.config.json"),
			at(join(root, "pair-index.tsx"), "mailwoman/commands/gazetteer/pair-index.tsx"),
		]

		expect(derivedWeightsKeyFrom(inputsFor(checkoutA))).toBe(derivedWeightsKeyFrom(inputsFor(checkoutB)))
	})

	it("returns a 16-hex-char key", () => {
		expect(derivedWeightsKeyFrom([])).toMatch(/^[0-9a-f]{16}$/)
	})
})

describe("derivedWeightsKey", () => {
	it("resolves against the real repo and returns a well-formed key", () => {
		expect(derivedWeightsKey()).toMatch(/^[0-9a-f]{16}$/)
	})

	it("names the generating CLI modules, not just the config and data", () => {
		// The whole point of the rewrite. If someone trims this list back to config+data, the
		// currency-filter class of stale artifact comes straight back.
		expect(DERIVED_WEIGHTS_INPUTS).toContain("mailwoman/commands/gazetteer/pair-index.tsx")
		expect(DERIVED_WEIGHTS_INPUTS).toContain("mailwoman/commands/gazetteer/postcode-binary.tsx")
	})
})

describe("derivedWeightsDir", () => {
	it("lands under the data root's derived/weights namespace", () => {
		expect(derivedWeightsDir("deadbeefdeadbeef")).toMatch(/\/derived\/weights\/deadbeefdeadbeef$/)
	})
})
