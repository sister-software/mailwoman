/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pins each layout against the libaddressinput `fmt` it was transcribed from, so the table cannot drift from its
 *   source unnoticed. A layout is data about a country's print order. a transcription error reads as a plausible
 *   address from somewhere else, which is the failure mode a diff against the source catches and a reader does not.
 *
 *   The comparison is over the SKELETON — the order of the fields and where the line breaks fall — not over the street
 *   line, because `%A` is one opaque field in the dataset and several tags here. A layout whose skeleton departs from
 *   its source on purpose is listed in {@link ACCEPTED_DEPARTURES} with the reason, which is the difference between a
 *   decision and a mistake.
 */

import {
	addr,
	isAlternation,
	isConnector,
	isLayout,
	isSlot,
	SLOTS,
	type AddressAtom,
	type AddressLayout,
} from "@mailwoman/codex/address-layout"
import {
	ADDRESS_LAYOUTS,
	GENERATED_ADDRESS_LAYOUTS,
	GENERATED_LATIN_ADDRESS_LAYOUTS,
	GENERATED_LOCAL_ADDRESS_LAYOUTS,
	isLargestFirstSystem,
	layoutForCountry,
	layoutPrintsLargestFirst,
	lineJoinForCountry,
} from "@mailwoman/codex/address-layouts"
import { joinRendering, renderAddress } from "@mailwoman/codex/address-render"
import type { ComponentTag } from "@mailwoman/codex/component"
import { describe, expect, it } from "vitest"

/**
 * Libaddressinput's placeholder vocabulary, in this project's tag names. `%A` is the street-address field this table
 * expands, so it maps to the marker the skeleton comparison treats as "the street line, however it is spelled".
 */
const FIELD: Readonly<Record<string, string>> = {
	N: "attention",
	O: "venue",
	A: "«street»",
	D: "dependent_locality",
	C: "locality",
	S: "region",
	Z: "postcode",
	X: "cedex",
	R: "country",
}

/**
 * Countries whose layout departs from the dataset skeleton, and why. An entry here is a decision. a departure without
 * one is a transcription error.
 */
const ACCEPTED_DEPARTURES: Readonly<Record<string, string>> = {
	// The dataset has no %D for France. La Poste's line 5 is the lieu-dit, which `fr/recipes/lieudit` renders and the
	// OpenCage FR template carries as a standalone `place` line, so the slot is kept between street and postcode.
	FR: "the lieu-dit line, which La Poste specifies and libaddressinput omits",
	// The dataset has no %D for Great Britain. Royal Mail's dependent locality is a real line above the post town.
	GB: "the dependent-locality line above the post town",
	// Japan's %A is one field below the prefecture. this table splits it into the tags the CJK model emits, and joins
	// the prefecture to it, because on one line the whole admin run is unseparated and only the postal code takes a
	// space.
	JP: "the sub-prefecture run is split into its own tags, and the prefecture joins it rather than taking a line",
	// China's %A is the street line only. the admin run above it is already %S%C%D in the dataset.
	CN: "the street line is split into street and house number",
	// Hong Kong's %S%n%C%n%A%n%O%n%N is the Chinese field order. This table holds one layout per country and the rest of
	// the codex already describes HK as small-first — `isLargestFirstSystem("HK")` is false and `LINE_JOINS` has no HK
	// entry — so the transcribed order renders `KLN, YAU TSIM MONG DISTRICT, 21 JORDAN ROAD`, which is neither register.
	HK: "the English register's order, which the rest of the codex already assumes for HK",
}

/**
 * The skeleton a layout prints, as field names per line, with the street line collapsed to one marker.
 */
function skeletonOf(atoms: readonly AddressAtom[]): string[] {
	const names: string[] = []

	for (const atom of atoms) {
		if (isConnector(atom)) continue

		if (isSlot(atom)) {
			names.push(atom.tag)

			continue
		}

		// An alternation or a nested layout is the street line however it is spelled.
		if (isAlternation(atom) || isLayout(atom)) {
			names.push("«street»")
		}
	}

	return names
}

/**
 * The skeleton a `fmt` string prints, as field names per line.
 */
function skeletonOfFormat(fmt: string): string[][] {
	return (
		fmt
			.split("%n")
			// An unmodeled placeholder is kept in its `%X` spelling rather than dropped: a skeleton that silently loses a
			// field compares equal to one that never had it.
			.map((line) => [...line.matchAll(/%([A-Z])/g)].map(([, code]) => FIELD[code!] ?? `%${code}`))
			.filter((line) => line.length)
	)
}

describe("ADDRESS_LAYOUTS", () => {
	it("covers every locale the project publishes weights for", () => {
		// The nine Latin locales in release.config.json plus the two CJK overlays.
		for (const country of ["US", "FR", "GB", "DE", "ES", "IT", "IN", "NZ", "AU", "JP", "CN"]) {
			expect(ADDRESS_LAYOUTS[country], `${country} has a layout`).toBeDefined()
		}
	})

	it("names only tags the union declares", async () => {
		const { COMPONENT_TAGS } = await import("@mailwoman/codex/component")
		const known = new Set<string>(COMPONENT_TAGS)

		for (const [country, layout] of Object.entries(ADDRESS_LAYOUTS)) {
			for (const line of layout.lines) {
				for (const name of skeletonOf(line)) {
					if (name === "«street»") continue

					expect(known.has(name), `${country} names ${name}`).toBe(true)
				}
			}
		}
	})

	it("prints its street line exactly once per layout", () => {
		for (const [country, layout] of Object.entries(ADDRESS_LAYOUTS)) {
			const streets = layout.lines.flatMap((line) => skeletonOf(line)).filter((n) => n === "«street»")

			expect(streets, `${country} prints one street line`).toHaveLength(1)
		}
	})
})

describe("the skeleton matches libaddressinput", () => {
	it("is documented for every accepted departure", () => {
		for (const country of Object.keys(ACCEPTED_DEPARTURES)) {
			expect(ADDRESS_LAYOUTS[country], `${country} has a layout to depart from`).toBeDefined()
		}
	})

	it("reads a `fmt` into the same vocabulary the layouts use", () => {
		// The US skeleton is the one every reader knows, so it is the fixture that proves the reader rather than the table.
		expect(skeletonOfFormat("%N%n%O%n%A%n%C, %S %Z")).toEqual([
			["attention"],
			["venue"],
			["«street»"],
			["locality", "region", "postcode"],
		])
	})
})

describe("a layout's printed order agrees with its system convention", () => {
	/**
	 * The render order comes from the layout and `LINE_JOINS` is picked by the system flag, so a disagreement prints one
	 * system's sequence with another's separators. HK rendered `KLN, YAU TSIM MONG DISTRICT, 21 JORDAN ROAD`.
	 */
	const both = [...new Set([...Object.keys(ADDRESS_LAYOUTS), ...Object.keys(GENERATED_ADDRESS_LAYOUTS)])]

	it("every country whose layout states an order states the same one as isLargestFirstSystem", () => {
		const disagreeing = both.filter((cc) => {
			const layout = layoutForCountry(cc)

			if (!layout) return false

			const printed = layoutPrintsLargestFirst(layout)

			return printed !== null && printed !== isLargestFirstSystem(cc)
		})

		expect(disagreeing).toEqual([])
	})

	it("reads the order off the four systems that print largest-first", () => {
		for (const cc of ["JP", "CN", "TW", "KR"]) {
			const layout = layoutForCountry(cc)

			if (!layout) continue

			expect(layoutPrintsLargestFirst(layout), cc).not.toBe(false)
		}
	})

	it("answers null for a layout naming no region or no street", () => {
		expect(layoutPrintsLargestFirst(addr`${SLOTS.locality}`)).toBeNull()
	})

	it("HK prints its English register", () => {
		expect(layoutPrintsLargestFirst(layoutForCountry("HK")!)).toBe(false)
	})
})

describe("a country that writes two orders carries both", () => {
	/**
	 * The eight records in the shipped dataset whose `lfmt` differs from their `fmt`. Listed rather than derived so the
	 * test states the population it covers; `layout-table-source.test.ts` is what compares the tables to the dataset.
	 */
	const TWO_SCRIPT_COUNTRIES = ["CN", "HK", "JP", "KP", "KR", "MO", "TH", "TW"] as const

	it("names exactly the eight the dataset distinguishes", () => {
		expect(Object.keys(GENERATED_LATIN_ADDRESS_LAYOUTS).toSorted()).toEqual([...TWO_SCRIPT_COUNTRIES])
		expect(Object.keys(GENERATED_LOCAL_ADDRESS_LAYOUTS).toSorted()).toEqual([...TWO_SCRIPT_COUNTRIES])
	})

	it("prints the Latin order smallest-first for every one of them", () => {
		for (const cc of TWO_SCRIPT_COUNTRIES) {
			expect(isLargestFirstSystem(cc, "latin"), cc).toBe(false)
		}
	})

	it("reaches Hong Kong's own script, which its hand-authored layout cannot state", () => {
		// The hand-authored HK entry is the Latin order, so before the split the Chinese order had nowhere to live and
		// `layoutForCountry("HK")` answered the English one for both scripts.
		expect(layoutPrintsLargestFirst(layoutForCountry("HK", "local")!)).toBe(true)
		expect(layoutPrintsLargestFirst(layoutForCountry("HK", "latin")!)).toBe(false)
		expect(layoutPrintsLargestFirst(layoutForCountry("HK")!)).toBe(false)
	})

	it("keeps the board-checked layout where it already states the local order", () => {
		// CN and JP are hand-authored and largest-first, so the generated skeleton must not displace them.
		for (const cc of ["CN", "JP"]) {
			expect(layoutForCountry(cc, "local"), cc).toBe(ADDRESS_LAYOUTS[cc])
		}
	})

	it("leaves a one-order country answering the same layout under either script", () => {
		for (const cc of ["US", "GB", "FR", "DE"]) {
			expect(layoutForCountry(cc, "latin"), cc).toBe(layoutForCountry(cc, "local"))
		}
	})

	it("never joins a Latin ordering with the local script's separator", () => {
		// The state that printed a Chinese field sequence with Latin separators: the order came from the layout while
		// the separator came from a country flag, so the two could name different systems.
		for (const cc of TWO_SCRIPT_COUNTRIES) {
			expect(lineJoinForCountry(cc, "latin"), cc).toBe(", ")
		}

		expect(lineJoinForCountry("JP")).toBe(" ")
		expect(lineJoinForCountry("JP", "local")).toBe(" ")
	})

	it("renders Hong Kong's two registers from components in their own script", () => {
		const english = { house_number: "21", street: "Jordan Road", locality: "Yau Tsim Mong", region: "Kowloon" }
		const chinese = { house_number: "21號", street: "佐敦道", locality: "油尖旺", region: "九龍" }

		const latin = joinRendering(
			renderAddress(layoutForCountry("HK", "latin")!, english),
			lineJoinForCountry("HK", "latin")
		)

		const local = joinRendering(
			renderAddress(layoutForCountry("HK", "local")!, chinese),
			lineJoinForCountry("HK", "local")
		)

		expect(latin).toBe("21 Jordan Road, Yau Tsim Mong, Kowloon")
		expect(local).toBe("九龍油尖旺佐敦道21號")
	})

	it("gives a caller who names no script the separator belonging to the layout they got", () => {
		// The defect this whole split exists for: the order came from the layout and the separator from a country flag,
		// so HK printed a Chinese field sequence with Latin separators. Hong Kong's default layout is its ENGLISH
		// register, so its default join must be the English one even though its local join is `""`.
		expect(lineJoinForCountry("HK")).toBe(", ")
		expect(lineJoinForCountry("HK", "local")).toBe("")
		expect(lineJoinForCountry("CN")).toBe("")
		expect(lineJoinForCountry("CN", "local")).toBe("")
		expect(lineJoinForCountry("US")).toBe(", ")
	})
})

describe("the admin run keeps its tier order in every layout", () => {
	/**
	 * `layoutPrintsLargestFirst` asks whether a layout runs large to small overall, and an inversion between two adjacent
	 * admin tiers leaves that answer unchanged: a Hong Kong layout printing the district above the area is still
	 * largest-first. The order between tiers is a relation between tags, so it is asserted as one.
	 *
	 * The sub-locality is the tier the generator AUTHORS wherever a `fmt` names no `%D`, and the one relation it has to
	 * get right is which side of the locality it lands on: the sub-locality sits between the street and the locality in
	 * either direction. Four generated skeletons (CR, KI, LV, RO) print the region between the street and the locality.
	 * that order is transcribed from the dataset rather than authored, and this check does not judge it.
	 */
	const TABLES = {
		hand: ADDRESS_LAYOUTS,
		generated: GENERATED_ADDRESS_LAYOUTS,
		latin: GENERATED_LATIN_ADDRESS_LAYOUTS,
		local: GENERATED_LOCAL_ADDRESS_LAYOUTS,
	} as const

	const FULL_ADDRESS = {
		attention: "ATTENTION",
		venue: "VENUE",
		house_number: "NUMBER",
		street: "STREET",
		dependent_locality: "DEPENDENT",
		locality: "LOCALITY",
		subregion: "SUBREGION",
		region: "REGION",
		postcode: "POSTCODE",
		country: "COUNTRY",
	}

	/**
	 * The tags a layout prints, in print order, read off a render of a full address so an alternation or a nested street
	 * node contributes what it prints rather than what it declares.
	 */
	function printedOrder(layout: AddressLayout): string[] {
		return renderAddress(layout, FULL_ADDRESS)
			.pieces.map((piece) => piece.tag)
			.filter((tag): tag is ComponentTag => tag !== null)
	}

	it("prints the sub-locality between the street and the locality, in every table", () => {
		const outside: string[] = []
		let judged = 0

		for (const [table, layouts] of Object.entries(TABLES)) {
			for (const [country, layout] of Object.entries(layouts)) {
				const order = printedOrder(layout)
				const street = order.findIndex((tag) => tag === "street" || tag === "house_number")
				const locality = order.indexOf("locality")
				const dependent = order.indexOf("dependent_locality")

				if (street === -1 || locality === -1 || dependent === -1) continue

				judged++

				const nearer = Math.min(street, locality)
				const farther = Math.max(street, locality)

				if (dependent < nearer || dependent > farther) {
					outside.push(`${table}/${country}: ${order.join(" → ")}`)
				}
			}
		}

		// The count states the population, so an empty `outside` cannot be a reader that found nothing to read.
		expect(judged).toBeGreaterThan(190)
		expect(outside).toEqual([])
	})

	it("prints Hong Kong's own script area-first, then the district", () => {
		expect(printedOrder(layoutForCountry("HK", "local")!)).toEqual([
			"country",
			"region",
			"locality",
			"dependent_locality",
			"street",
			"house_number",
			"venue",
			"attention",
		])
	})
})
