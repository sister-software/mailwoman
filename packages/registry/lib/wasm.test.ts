/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parity of the WebAssembly batch kernels, scalar and simd, with the TypeScript reader over every three-letter key.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { describe, expect, it } from "vitest"

import { airportMembership } from "#iata/airports/validate"
import { alpha3Membership } from "#iso3166/alpha3"
import { decode3, KEY_SPACE_3 } from "#key"
import { collisionMembership } from "#overlap/country-airport"
import { ClassifyMask, createRegistry, preferredWasmVariant, registryWasmURL, type WasmVariant } from "#wasm"

const encoder = new TextEncoder()

/**
 * The mask bits are disjoint powers of two, so a sum equals the bitwise union.
 */
function expectedMask(key: number): number {
	let mask = 0

	if (alpha3Membership().test(key)) {
		mask += ClassifyMask.Country
	}

	if (airportMembership().test(key)) {
		mask += ClassifyMask.Airport
	}

	if (collisionMembership().test(key)) {
		mask += ClassifyMask.Collision
	}

	return mask
}

const variants: WasmVariant[] = preferredWasmVariant() === "simd" ? ["scalar", "simd"] : ["scalar"]

describe.each(variants)("registry wasm (%s)", (variant) => {
	it("classifies all 17,576 keys as the TypeScript reader does, in one batch", async () => {
		const registry = await createRegistry({ wasm: await readLocalBuffer(registryWasmURL(variant)) })

		expect(registry.simd).toBe(variant === "simd")

		const packed = new Uint8Array(KEY_SPACE_3 * 3)

		for (let key = 0; key < KEY_SPACE_3; key++) {
			packed.set(encoder.encode(decode3(key)), key * 3)
		}

		const out = new Uint8Array(KEY_SPACE_3)

		expect(registry.countryAirport.classifyManyInto(packed, out)).toBe(KEY_SPACE_3)

		for (let key = 0; key < KEY_SPACE_3; key++) {
			expect(out[key], decode3(key)).toBe(expectedMask(key))
		}

		registry.dispose()
	})

	it("marks malformed codes invalid and refuses a short output", async () => {
		const registry = await createRegistry({ wasm: await readLocalBuffer(registryWasmURL(variant)) })
		// A country code no airport holds, read from the tables rather than guessed.
		let countryOnly = ""

		for (let key = 0; key < KEY_SPACE_3 && !countryOnly; key++) {
			if (alpha3Membership().test(key) && !airportMembership().test(key)) {
				countryOnly = decode3(key)
			}
		}

		const masks = registry.countryAirport.classify(["AUS", "aus", "SFO", "A1S", countryOnly, "ZZZZ"])

		expect([...masks]).toEqual([
			ClassifyMask.Country | ClassifyMask.Airport | ClassifyMask.Collision,
			ClassifyMask.Invalid,
			ClassifyMask.Airport,
			ClassifyMask.Invalid,
			ClassifyMask.Country,
			ClassifyMask.Invalid,
		])

		expect(() => registry.countryAirport.classifyManyInto(new Uint8Array(9), new Uint8Array(2), 3)).toThrow(RangeError)

		registry.dispose()
	})

	it("reuses its staging buffers across calls of the same size", async () => {
		const registry = await createRegistry({ wasm: await readLocalBuffer(registryWasmURL(variant)) })
		const packed = encoder.encode("AUSFRASFO")
		const out = new Uint8Array(3)

		for (let round = 0; round < 1000; round++) {
			registry.countryAirport.classifyManyInto(packed, out)
		}

		expect([...out]).toEqual([7, 7, 2])

		registry.dispose()
	})
})
