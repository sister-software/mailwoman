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

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { mkdir, rm, writeFile } from "@mailwoman/platform/fs/promises"
import { join } from "@mailwoman/platform/path"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	DERIVED_WEIGHTS_INPUTS,
	type DerivedWeightsInput,
	derivedStoreServeViolation,
	derivedWeightsDir,
	derivedWeightsKey,
	derivedWeightsKeyFrom,
} from "./derived-weights-key.ts"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * Name an absolute path by its basename — the shape production uses (repo-relative name, absolute read path).
 */
function at(path: string, name?: string): DerivedWeightsInput {
	return { name: name ?? path.slice(path.lastIndexOf("/") + 1), path }
}

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("derived-weights-key-")
})

afterEach(() => scratch[Symbol.asyncDispose]())

describe("derivedWeightsKeyFrom", () => {
	it("is stable for identical inputs", async () => {
		const a = scratch.resolve("a.json")
		await writeFile(a, '{"x":1}')

		expect(derivedWeightsKeyFrom([at(a)])).toBe(derivedWeightsKeyFrom([at(a)]))
	})

	it("changes when a hashed input's CONTENT changes", async () => {
		const a = scratch.resolve("a.json")
		await writeFile(a, '{"x":1}')
		const before = derivedWeightsKeyFrom([at(a)])

		await writeFile(a, '{"x":2}')

		expect(derivedWeightsKeyFrom([at(a)])).not.toBe(before)
	})

	it("changes when a GENERATING MODULE changes — the currency-filter regression", async () => {
		const config = scratch.resolve("release.config.json")
		const generator = scratch.resolve("pair-index.tsx")
		await writeFile(config, '{"weights":{"model":"m.onnx"}}')
		await writeFile(generator, "export const delta = 1")
		const before = derivedWeightsKeyFrom([at(config), at(generator)])

		// The config is untouched; only the code that produces the binaries changed.
		await writeFile(generator, "export const delta = 2")

		expect(derivedWeightsKeyFrom([at(config), at(generator)])).not.toBe(before)
	})

	it("is order-independent across the input list", async () => {
		const a = scratch.resolve("a.json")
		const b = scratch.resolve("b.json")
		await writeFile(a, "1")
		await writeFile(b, "2")

		expect(derivedWeightsKeyFrom([at(a), at(b)])).toBe(derivedWeightsKeyFrom([at(b), at(a)]))
	})

	it("treats a MISSING input as a distinct state, not as empty", async () => {
		const a = scratch.resolve("a.json")
		await writeFile(a, "1")
		const present = derivedWeightsKeyFrom([at(a)])

		await rm(a)
		const absent = derivedWeightsKeyFrom([at(a)])

		const empty = scratch.resolve("empty.json")
		await writeFile(empty, "")

		// Absence is not zero: a file that is gone must not hash like a file that is empty.
		expect(absent).not.toBe(present)
		expect(absent).not.toBe(derivedWeightsKeyFrom([at(empty)]))
	})

	it("distinguishes inputs by NAME", async () => {
		const a = scratch.resolve("a.json")
		const b = scratch.resolve("b.json")
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
		const checkoutA = scratch.resolve("runner-1", "_work", "mailwoman")
		const checkoutB = scratch.resolve("runner-2", "_work", "mailwoman")

		for (const root of [checkoutA, checkoutB]) {
			await mkdir(root, { recursive: true })
			await writeFile(join(root, "release.config.json"), '{"weights":{"model":"m.onnx"}}')
			await writeFile(join(root, "pair-index.tsx"), "export const delta = 10")
		}

		const inputsFor = (root: string) => [
			at(join(root, "release.config.json"), "release.config.json"),
			at(join(root, "pair-index.tsx"), "packages/mailwoman/commands/gazetteer/pair-index.tsx"),
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
		expect(DERIVED_WEIGHTS_INPUTS).toContain("packages/mailwoman/commands/gazetteer/pair-index.tsx")
		expect(DERIVED_WEIGHTS_INPUTS).toContain("packages/mailwoman/commands/gazetteer/postcode-binary.tsx")
	})
})

describe("derivedWeightsDir", () => {
	it("lands under the data root's derived/weights namespace", () => {
		expect(derivedWeightsDir("deadbeefdeadbeef")).toMatch(/\/derived\/weights\/deadbeefdeadbeef$/)
	})
})

describe("derivedStoreServeViolation — the serve-time floor (#1528)", () => {
	function pcb1(records: number): Buffer {
		const header = Buffer.alloc(9)
		header.write("PCB1", 0, "latin1")
		header.writeUInt32LE(records, 4)
		header.writeUInt8(1, 8)

		return header
	}

	let dir: string

	beforeEach(async () => {
		dir = fixtures.use(await temporaryDirectory("derived-serve-")).path
	})

	it("refuses the #1528 reproduction: an empty GB binary is never a valid entry", async () => {
		const path = join(dir, "postcode-gb.bin")
		await writeFile(path, pcb1(0))

		expect(derivedStoreServeViolation("postcode-gb.bin", path)).toMatch(/below the GB floor/)
	})

	it("refuses a collapsed FR binary below its calibrated floor", async () => {
		const path = join(dir, "postcode-fr.bin")
		await writeFile(path, pcb1(500))

		expect(derivedStoreServeViolation("postcode-fr.bin", path)).toMatch(/below the FR floor of 13,000/)
	})

	it("serves a GB binary at outward granularity — the LOWEST GB floor is the serve gate", async () => {
		const path = join(dir, "postcode-gb.bin")
		await writeFile(path, pcb1(1500))

		expect(derivedStoreServeViolation("postcode-gb.bin", path)).toBeNull()
	})

	it("refuses bytes that are not a PCB1 at all", async () => {
		const path = join(dir, "postcode-de.bin")
		await writeFile(path, Buffer.from("not a binary"))

		expect(derivedStoreServeViolation("postcode-de.bin", path)).toMatch(/not a PCB1/)
	})

	it("passes non-postcode entries untouched — pair indexes validate their own header on load", async () => {
		const path = join(dir, "pair-index-gb.bin")
		await writeFile(path, Buffer.from("anything"))

		expect(derivedStoreServeViolation("pair-index-gb.bin", path)).toBeNull()
	})
})
