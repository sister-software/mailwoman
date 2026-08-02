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

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	DERIVED_WEIGHTS_INPUTS,
	derivedWeightsDir,
	derivedWeightsKey,
	derivedWeightsKeyFrom,
} from "./derived-weights-key.ts"

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

		expect(derivedWeightsKeyFrom([a])).toBe(derivedWeightsKeyFrom([a]))
	})

	it("changes when a hashed input's CONTENT changes", async () => {
		const a = join(scratch, "a.json")
		await writeFile(a, '{"x":1}')
		const before = derivedWeightsKeyFrom([a])

		await writeFile(a, '{"x":2}')

		expect(derivedWeightsKeyFrom([a])).not.toBe(before)
	})

	it("changes when a GENERATING MODULE changes — the currency-filter regression", async () => {
		const config = join(scratch, "release.config.json")
		const generator = join(scratch, "pair-index.tsx")
		await writeFile(config, '{"weights":{"model":"m.onnx"}}')
		await writeFile(generator, "export const delta = 1")
		const before = derivedWeightsKeyFrom([config, generator])

		// The config is untouched; only the code that produces the binaries changed.
		await writeFile(generator, "export const delta = 2")

		expect(derivedWeightsKeyFrom([config, generator])).not.toBe(before)
	})

	it("is order-independent across the input list", async () => {
		const a = join(scratch, "a.json")
		const b = join(scratch, "b.json")
		await writeFile(a, "1")
		await writeFile(b, "2")

		expect(derivedWeightsKeyFrom([a, b])).toBe(derivedWeightsKeyFrom([b, a]))
	})

	it("treats a MISSING input as a distinct state, not as empty", async () => {
		const a = join(scratch, "a.json")
		await writeFile(a, "1")
		const present = derivedWeightsKeyFrom([a])

		await rm(a)
		const absent = derivedWeightsKeyFrom([a])

		const empty = join(scratch, "empty.json")
		await writeFile(empty, "")

		// Absence is not zero: a file that is gone must not hash like a file that is empty.
		expect(absent).not.toBe(present)
		expect(absent).not.toBe(derivedWeightsKeyFrom([empty]))
	})

	it("distinguishes the same bytes under different names", async () => {
		const a = join(scratch, "a.json")
		const b = join(scratch, "b.json")
		await writeFile(a, "same")
		await writeFile(b, "same")

		// Path is part of the key, so moving an input is a change.
		expect(derivedWeightsKeyFrom([a])).not.toBe(derivedWeightsKeyFrom([b]))
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
