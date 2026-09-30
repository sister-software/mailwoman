/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What each country's layout was derived from.
 *
 *   The basis answers which document a layout cites. #2323 asks for UPU S42, and no layout here reads from it:
 *   every print order comes from libaddressinput's `fmt` or `lfmt`, or from a hand-authored entry checked on a
 *   board. `PostalStandardS42` is declared so that a transcribed layout can claim it, and the test below records
 *   that none does.
 */

import { describe, expect, it } from "vitest"

import {
	ADDRESS_LAYOUTS,
	LayoutBasis,
	layoutBasisForCountry,
	layoutForCountry,
	layoutPrintsLargestFirst,
} from "#address/layouts"
import {
	GENERATED_ADDRESS_LAYOUTS,
	GENERATED_LATIN_ADDRESS_LAYOUTS,
	GENERATED_LOCAL_ADDRESS_LAYOUTS,
} from "#address/layouts/generated"

describe("layoutBasisForCountry", () => {
	it("answers a basis for exactly the countries that have a layout", () => {
		const codes = new Set([...Object.keys(GENERATED_ADDRESS_LAYOUTS), ...Object.keys(ADDRESS_LAYOUTS)])

		for (const code of codes) {
			expect(layoutBasisForCountry(code), code).not.toBeNull()
		}

		expect(layoutBasisForCountry("ZZ")).toBeNull()
		expect(layoutBasisForCountry("")).toBeNull()
		expect(layoutBasisForCountry(null)).toBeNull()
	})

	it("reads the hand-authored basis for a locale this project publishes weights for", () => {
		expect(layoutBasisForCountry("US")).toBe(LayoutBasis.BoardChecked)
		expect(layoutBasisForCountry("FR")).toBe(LayoutBasis.BoardChecked)
	})

	it("reads the generated basis for a country with no hand-authored entry", () => {
		const generatedOnly = Object.keys(GENERATED_ADDRESS_LAYOUTS).find((code) => !ADDRESS_LAYOUTS[code])!

		expect(layoutBasisForCountry(generatedOnly)).toBe(LayoutBasis.LibAddressInputFormat)
	})

	it("reads the Latin basis for a country whose Latin order is separate", () => {
		for (const code of Object.keys(GENERATED_LATIN_ADDRESS_LAYOUTS)) {
			expect(layoutBasisForCountry(code, "latin"), code).toBe(LayoutBasis.LibAddressInputLatinFormat)
		}
	})

	it("names the same table `layoutForCountry` reads, for every country and both scripts", () => {
		// A basis that disagrees with the layout a caller receives would attribute
		// one table's derivation to another table's bytes.
		const codes = new Set([
			...Object.keys(GENERATED_ADDRESS_LAYOUTS),
			...Object.keys(ADDRESS_LAYOUTS),
			...Object.keys(GENERATED_LATIN_ADDRESS_LAYOUTS),
			...Object.keys(GENERATED_LOCAL_ADDRESS_LAYOUTS),
		])

		for (const script of ["local", "latin"] as const) {
			for (const code of codes) {
				const layout = layoutForCountry(code, script)
				const basis = layoutBasisForCountry(code, script)

				if (!layout) {
					expect(basis, `${code}/${script}`).toBeNull()

					continue
				}

				const expected =
					layout === GENERATED_LATIN_ADDRESS_LAYOUTS[code]
						? LayoutBasis.LibAddressInputLatinFormat
						: layout === ADDRESS_LAYOUTS[code]
							? LayoutBasis.BoardChecked
							: LayoutBasis.LibAddressInputFormat

				expect(basis, `${code}/${script}`).toBe(expected)
			}
		}
	})

	it("claims no UPU S42 transcription, because none has been made", () => {
		const codes = new Set([...Object.keys(GENERATED_ADDRESS_LAYOUTS), ...Object.keys(ADDRESS_LAYOUTS)])
		const transcribed = [...codes].filter((code) => layoutBasisForCountry(code) === LayoutBasis.PostalStandardS42)

		expect(transcribed).toEqual([])
	})

	it("reads a different basis per script where the two orders disagree", () => {
		// Hong Kong's hand-authored entry states the Latin order, so its local order
		// comes from the generated table and its basis follows.
		const disagreeing = Object.keys(GENERATED_LOCAL_ADDRESS_LAYOUTS).filter((code) => {
			const hand = ADDRESS_LAYOUTS[code]
			const local = GENERATED_LOCAL_ADDRESS_LAYOUTS[code]

			return hand && local && layoutPrintsLargestFirst(hand) !== layoutPrintsLargestFirst(local)
		})

		for (const code of disagreeing) {
			expect(layoutBasisForCountry(code, "local"), code).toBe(LayoutBasis.LibAddressInputFormat)
			expect(layoutBasisForCountry(code), code).toBe(LayoutBasis.BoardChecked)
		}
	})
})
