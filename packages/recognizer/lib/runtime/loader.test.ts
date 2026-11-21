// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The loader in Node: an import does no WebAssembly work, the first call instantiates the
 *   engine synchronously, `init` accepts bytes or a module, an ABI mismatch and a mismatched
 *   declarations hash are refused with clear errors, and a trap makes the instance unusable.
 *
 *   Each test imports a fresh copy of the package, because the loader keeps
 *   one engine instance per module graph.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ABI_VERSION } from "#runtime/abi"
import { type CompiledModule, type ModuleBytes, wasm } from "#runtime/webassembly"

const wasmPath = workspacePath("recognizer", "wasm", "recognizer.wasm")

/**
 * A module whose `rcg_abi_version` returns 2, the previous ABI and the smallest
 * module the loader would accept before its version check.
 */
const WRONG_ABI = new Uint8Array([
	0,
	0x61,
	0x73,
	0x6d,
	1,
	0,
	0,
	0, // magic and version
	1,
	5,
	1,
	0x60,
	0,
	1,
	0x7f, // type: () -> i32
	3,
	2,
	1,
	0, // one function
	7,
	0x13,
	1,
	0x0f,
	...Array.from("rcg_abi_version", (character) => character.charCodeAt(0)),
	0,
	0, // export
	0x0a,
	6,
	1,
	4,
	0,
	0x41,
	2,
	0x0b, // body: i32.const 2
])

let constructed = 0
const originalModule = wasm.Module
const originalInstance = wasm.Instance

beforeEach(() => {
	constructed = 0

	// Count the constructions the loader makes.
	// They're its only WebAssembly work.
	wasm.Module = class extends originalModule {
		constructor(bytes: ModuleBytes) {
			super(bytes)

			constructed++
		}
	}

	wasm.Instance = class extends originalInstance {
		constructor(module: CompiledModule, imports: object) {
			super(module, imports)

			constructed++
		}
	}
})

afterEach(() => {
	wasm.Module = originalModule
	wasm.Instance = originalInstance
})

async function load() {
	vi.resetModules()

	const entry = await import("#index")
	const state = await import("#runtime/state")
	const { coordinates } = await import("#coordinates")
	const { primitives } = await import("#primitives")

	return { entry, state, coordinates, primitives }
}

describe("the loader", () => {
	it("does no WebAssembly work on import or on creating a recognizer", async () => {
		const { entry, state, coordinates } = await load()

		entry.createRecognizer([coordinates])

		expect(constructed).toBe(0)
		expect(state.stateKind()).toBe("uninitialized")
	})

	it("instantiates the embedded engine synchronously on the first call", async () => {
		const { entry, state, coordinates, primitives } = await load()
		const recognizer = entry.createRecognizer([primitives, coordinates])
		const result = recognizer.recognize("at 40.7128, -74.0060 now")

		expect(state.stateKind()).toBe("ready")
		// One module and one instance serve every call that follows.
		expect(constructed).toBe(2)
		recognizer.recognize("1, 2")
		expect(constructed).toBe(2)

		const pair = result.recognitions.find((recognition) => recognition.kind === "coordinate.decimal_pair")

		expect(pair).toMatchObject({ start: 3, end: 20, text: "40.7128, -74.0060" })

		expect(pair?.validation).toEqual({
			status: "validated",
			payload: { latitude: 40.7128, longitude: -74.006, order: "lat_lon" },
		})

		expect(result.fields).toEqual({})
	})

	it("preloads from bytes, and from a compiled module", async () => {
		const bytes = await readLocalBuffer(wasmPath)

		for (const source of [{ bytes: new Uint8Array(bytes) }, { module: new wasm.Module(new Uint8Array(bytes)) }]) {
			const { entry, state, coordinates } = await load()

			constructed = 0
			await entry.init(source)

			expect(state.stateKind()).toBe("ready")

			const { recognitions } = entry.createRecognizer([coordinates]).recognize("1.5,2.5")

			expect(recognitions).toHaveLength(1)
			// `init` compiles bytes with the asynchronous `WebAssembly.compile` and constructs one instance either way.
			expect(constructed).toBe(1)
			await expect(entry.init()).resolves.toBeUndefined()
		}
	})

	it("refuses a second source before the first is ready, and a call while it is pending", async () => {
		const bytes = new Uint8Array(await readLocalBuffer(wasmPath))
		const { entry, coordinates } = await load()
		const pending = entry.init({ bytes })

		expect(() => entry.createRecognizer([coordinates]).recognize("1, 2")).toThrow(/await it before recognizing/u)
		await expect(entry.init({ bytes: new Uint8Array(bytes) })).rejects.toThrow(entry.RecognizerInitializationError)
		await pending
	})

	it("rejects a bad init argument", async () => {
		const { entry } = await load()

		// The wrong shapes a JavaScript caller can pass.
		// The option type refuses them at compile time.
		const loose: (options: object) => Promise<void> = entry.init

		await expect(loose({ bytes: "not bytes" })).rejects.toThrow(TypeError)
		await expect(loose({ module: {} })).rejects.toThrow(TypeError)
		await expect(loose({ module: {}, bytes: new Uint8Array() })).rejects.toThrow(TypeError)
	})

	it("tells the caller to await init when the first call cannot instantiate", async () => {
		const { entry, state, coordinates } = await load()

		state.setDefaultSource(() => new Uint8Array([1, 2, 3]))

		const call = () => entry.createRecognizer([coordinates]).recognize("1, 2")

		expect(call).toThrow(entry.RecognizerInitializationError)
		expect(call).toThrow(/await init\(\{ module \}\) or init\(\{ bytes \}\)/u)
	})

	it("refuses an engine whose ABI version differs", async () => {
		const { entry, state, coordinates } = await load()

		state.setDefaultSource(() => WRONG_ABI)

		expect(() => entry.createRecognizer([coordinates]).recognize("1, 2")).toThrow(
			new RegExp(`ABI version 2 does not match the loader's ABI version ${ABI_VERSION}`, "u")
		)
	})

	it("refuses an artifact whose declarations hash differs from the declarations it is loaded beside", async () => {
		const { entry, coordinates } = await load()

		const stale = entry.defineFamily({
			id: coordinates.id,
			kinds: coordinates.kinds,
			declarationsHash: "0".repeat(64),
			artifact: coordinates.artifact,
		})

		const call = () => entry.createRecognizer([stale]).recognize("1, 2")

		expect(call).toThrow(entry.RecognizerArtifactError)
		expect(call).toThrow(/not built from the declarations it is loaded beside.*declarations hash/su)
	})

	it("refuses a corrupt artifact", async () => {
		const { entry, coordinates } = await load()

		const corrupt = entry.defineFamily({
			id: coordinates.id,
			kinds: coordinates.kinds,
			declarationsHash: coordinates.declarationsHash,
			artifact: () => {
				const bytes = coordinates.artifact().slice()

				bytes[0] = 0x58

				return bytes
			},
		})

		expect(() => entry.createRecognizer([corrupt]).recognize("1, 2")).toThrow(
			/refused the artifact of family coordinates/u
		)
	})

	it("poisons the instance on a trap and says so on every later call", async () => {
		const { entry, state, coordinates } = await load()
		const recognizer = entry.createRecognizer([coordinates])

		recognizer.recognize("1, 2")

		const { exports } = state.ready()

		// A read far outside linear memory traps.
		let trap: unknown

		try {
			exports.rcg_recognize(exports.memory.buffer.byteLength - 4, 64, 1)
		} catch (error) {
			trap = state.trapped(error)
		}

		expect(trap).toBeInstanceOf(entry.RecognizerRuntimeError)
		expect(state.stateKind()).toBe("poisoned")
		expect(() => recognizer.recognize("1, 2")).toThrow(/trapped and cannot be reused/u)
		await expect(entry.init()).rejects.toThrow(entry.RecognizerRuntimeError)
	})

	it("serves recognizers over different families from one engine", async () => {
		const { entry, coordinates, primitives } = await load()
		const onlyCoordinates = entry.createRecognizer([coordinates])
		const both = entry.createRecognizer([primitives, coordinates])

		expect(
			onlyCoordinates.recognize("ab 1, 2").recognitions.every((recognition) => recognition.family === "coordinates")
		).toBe(true)

		expect(both.recognize("ab 1, 2").recognitions.some((recognition) => recognition.family === "primitives")).toBe(true)
		expect(constructed).toBe(2)
	})

	it("refuses a family listed twice", async () => {
		const { entry, coordinates } = await load()

		expect(() => entry.createRecognizer([coordinates, coordinates])).toThrow(/listed twice/u)
	})

	it("reports text past the family limit as a RangeError and keeps working", async () => {
		const { entry, coordinates } = await load()
		const recognizer = entry.createRecognizer([coordinates])

		expect(() => recognizer.recognize("1".repeat(70_000))).toThrow(RangeError)
		expect(recognizer.recognize("1, 2").recognitions).toHaveLength(1)
	})

	it("returns UTF-16 spans that slice the text back on astral, combining, CJK and mixed-script input", async () => {
		const { entry, coordinates, primitives } = await load()
		const recognizer = entry.createRecognizer([primitives, coordinates])

		for (const text of [
			"😀😀 40.5, -74.25 😀",
			"é 12.5,7 東京 3",
			"〒100-0001 東京都 1.0, 2.0",
			"Москва 55.75, 37.62 مدينة",
		]) {
			const { recognitions } = recognizer.recognize(text)

			expect(recognitions.length).toBeGreaterThan(0)

			for (const recognition of recognitions) {
				expect(text.slice(recognition.start, recognition.end)).toBe(recognition.text)
				// No span begins or ends between the halves of a surrogate pair.
				const before = text.charCodeAt(recognition.start - 1)
				const first = text.charCodeAt(recognition.start)
				const last = text.charCodeAt(recognition.end - 1)
				const after = text.charCodeAt(recognition.end)

				expect(before >= 0xd8_00 && before <= 0xdb_ff && first >= 0xdc_00 && first <= 0xdf_ff).toBe(false)
				expect(last >= 0xd8_00 && last <= 0xdb_ff && after >= 0xdc_00 && after <= 0xdf_ff).toBe(false)
			}
		}

		const wide = recognizer
			.recognize("😀😀 40.5, -74.25 😀")
			.recognitions.find((recognition) => recognition.kind === "coordinate.decimal_pair")

		expect(wide).toMatchObject({ start: 5, end: 17, text: "40.5, -74.25" })
	})
})
