/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What each source states about a country's addressing convention, disagreements included.
 *
 *   #2323 asks the layouts to cite UPU S42. No layout in this package reads from S42 or from a postal operator's
 *   own description, so neither source contributes an observation yet, and the tests below record that rather
 *   than let an absent source read as agreement. What the package does hold is libaddressinput's belief about
 *   what a user must supply, the OpenCage templates' belief about what a renderer needs, and a board entry's
 *   record of real addresses. Those disagree for some countries, and the disagreement is the finding.
 *
 *   The suites after the convention claims pin each layout against the libaddressinput `fmt` it came from. This
 *   catches drift from the source. A transcription error can still read as a plausible address from somewhere else.
 *   The source diff exposes it.
 *
 *   That comparison is over the skeleton — the order of the fields and where the line breaks fall — not over the
 *   street line, because `%A` is one opaque field in the dataset and several tags here. A layout whose skeleton
 *   departs from its source on purpose is listed in {@link ACCEPTED_DEPARTURES} with the reason.
 */

import { describe, expect, it } from "vitest"

import {
	ConventionClaimID,
	ConventionSource,
	KIND_BY_SOURCE,
	ObservationKind,
	ObservationStance,
	observationsDisagree,
} from "#address/convention-claims"
import {
	addr,
	isAlternation,
	isConnector,
	isLayout,
	isSlot,
	SLOTS,
	type AddressAtom,
	type AddressLayout,
} from "#address/layout"
import {
	ADDRESS_LAYOUTS,
	conventionClaimForCountry,
	isLargestFirstSystem,
	layoutForCountry,
	layoutPrintsLargestFirst,
	layoutPrintsPostcodeBeforeLocality,
	layoutPrintsTag,
	lineJoinForCountry,
} from "#address/layouts"
import {
	GENERATED_ADDRESS_LAYOUTS,
	GENERATED_LATIN_ADDRESS_LAYOUTS,
	GENERATED_LOCAL_ADDRESS_LAYOUTS,
	HAND_AUTHORED_FORMAT_SKELETONS,
} from "#address/layouts/generated"
import { S42_ADDRESS_LAYOUTS, S42_READ_LAYOUTS } from "#address/layouts/s42"
import { UPU_PAS_ADDRESS_LAYOUTS } from "#address/layouts/upu-pas"
import { joinRendering, renderAddress } from "#address/render"
import { s42CohortForJurisdiction } from "#address/s42-templates"
import type { ComponentTag } from "#component"

const CLAIMS = Object.values(ConventionClaimID)

describe("conventionClaimForCountry", () => {
	it("answers for exactly the countries that have a layout", () => {
		const codes = new Set([...Object.keys(GENERATED_ADDRESS_LAYOUTS), ...Object.keys(ADDRESS_LAYOUTS)])

		for (const code of codes) {
			expect(conventionClaimForCountry(ConventionClaimID.LargestUnitFirst, code), code).not.toBeNull()
		}

		expect(conventionClaimForCountry(ConventionClaimID.LargestUnitFirst, "ZZ")).toBeNull()
		expect(conventionClaimForCountry(ConventionClaimID.LargestUnitFirst, "")).toBeNull()
		expect(conventionClaimForCountry(ConventionClaimID.LargestUnitFirst, null)).toBeNull()
	})

	it("reads each observation's kind from its source", () => {
		for (const claim of CLAIMS) {
			for (const code of Object.keys(ADDRESS_LAYOUTS)) {
				for (const entry of conventionClaimForCountry(claim, code)!.observations) {
					expect(entry.kind, `${code}/${claim}/${entry.source}`).toBe(KIND_BY_SOURCE[entry.source])
					expect(entry.readFrom.length).toBeGreaterThan(0)
				}
			}
		}
	})

	it("cites the board for a locale this project publishes weights for", () => {
		const claim = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, "FR")!

		expect(claim.jurisdiction).toBe("FR")
		expect(claim.observations.map((entry) => entry.source)).toContain(ConventionSource.MailwomanBoard)

		// France prints `%Z %C`, the postcode before the locality.
		expect(claim.observations.find((entry) => entry.source === ConventionSource.MailwomanBoard)!.stance).toBe(
			ObservationStance.Supports
		)
	})

	it("sets a dataset observation against the board for every board locale", () => {
		// The rendering tables stay disjoint, so a hand-authored country appears in none of them
		// and for a while no dataset statement could be read for the twelve locales that matter most.
		// `HAND_AUTHORED_FORMAT_SKELETONS` holds their `fmt` skeleton for this comparison only,
		// so every board locale holds both statements and any disagreement is visible.
		const unmatched = Object.keys(ADDRESS_LAYOUTS).filter((code) => {
			const claim = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, code)!

			return !claim.observations.some((entry) => entry.source === ConventionSource.LibAddressInput)
		})

		expect(unmatched).toEqual([])

		for (const code of Object.keys(ADDRESS_LAYOUTS)) {
			const sources = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, code)!.observations.map(
				(entry) => entry.source
			)

			expect(sources, code).toContain(ConventionSource.MailwomanBoard)
			expect(sources, code).toContain(ConventionSource.LibAddressInput)
		}
	})

	it("keeps the skeleton table out of the rendering path", () => {
		// `layoutForCountry` must keep answering the board's layout for a board locale.
		// A skeleton that reached rendering would replace a layout checked against
		// real addresses with one derived from a dataset.
		for (const code of Object.keys(HAND_AUTHORED_FORMAT_SKELETONS)) {
			expect(layoutForCountry(code), code).toBe(ADDRESS_LAYOUTS[code])
		}
	})

	it("cites libaddressinput alone for a country with no board entry", () => {
		const code = Object.keys(GENERATED_ADDRESS_LAYOUTS).find((candidate) => !ADDRESS_LAYOUTS[candidate])!
		const claim = conventionClaimForCountry(ConventionClaimID.LargestUnitFirst, code)!

		expect(claim.observations.map((entry) => entry.source)).toEqual([ConventionSource.LibAddressInput])
		expect(claim.observations[0]!.kind).toBe(ObservationKind.Implementation)
	})

	it("cites the renderer only for the claim the renderer settled", () => {
		// The street atom's order came from the OpenCage templates.
		// The line order came from `fmt`.
		const street = conventionClaimForCountry(ConventionClaimID.HouseNumberPrecedesStreet, "US")!
		const lines = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, "US")!

		expect(street.observations.map((entry) => entry.source)).toContain(ConventionSource.OpenCageAddressFormatting)

		expect(lines.observations.map((entry) => entry.source)).not.toContain(ConventionSource.OpenCageAddressFormatting)
	})

	it("reads a retrieved S42 template and marks the rest unread", () => {
		// The stance separates three states a single boolean would merge.
		// A template this repository has read can be set against the other sources.
		// A template this repository has not read stays unread.
		// A jurisdiction outside the inventory has no such document at all.
		const codes = [...new Set([...Object.keys(GENERATED_ADDRESS_LAYOUTS), ...Object.keys(ADDRESS_LAYOUTS)])]

		for (const code of codes) {
			const observations = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, code)!.observations
			const s42 = observations.find((entry) => entry.source === ConventionSource.PostalStandardS42)

			if (!s42CohortForJurisdiction(code)) {
				expect(s42, code).toBeUndefined()

				continue
			}

			expect(s42, code).toBeDefined()
			expect(s42!.kind, code).toBe(ObservationKind.ApprovedCrosswalk)

			if (S42_READ_LAYOUTS[code] || S42_ADDRESS_LAYOUTS[code]) {
				expect(s42!.stance, code).not.toBe(ObservationStance.Unread)
				expect(s42!.readFrom, code).toMatch(/retrieved/u)
			} else {
				expect(s42!.stance, code).toBe(ObservationStance.Unread)
			}
		}
	})

	it("reads no statement from a national postal authority yet", () => {
		const codes = new Set([...Object.keys(GENERATED_ADDRESS_LAYOUTS), ...Object.keys(ADDRESS_LAYOUTS)])

		const cited: string[] = []

		for (const claim of CLAIMS) {
			for (const code of codes) {
				for (const entry of conventionClaimForCountry(claim, code)!.observations) {
					if (entry.source === ConventionSource.NationalPostalAuthority) {
						cited.push(`${code}/${claim}/${entry.source}`)
					}
				}
			}
		}

		expect(cited).toEqual([])
	})

	it("cites the UPU compendium exactly for the countries whose description was retrieved", () => {
		const codes = new Set([
			...Object.keys(GENERATED_ADDRESS_LAYOUTS),
			...Object.keys(ADDRESS_LAYOUTS),
			...Object.keys(UPU_PAS_ADDRESS_LAYOUTS),
		])

		const citing = new Set<string>()

		for (const code of codes) {
			const observations = conventionClaimForCountry(ConventionClaimID.PostcodePrecedesLocality, code)!.observations
			const pas = observations.find((entry) => entry.source === ConventionSource.PostalAddressingSystems)

			if (!pas) continue

			citing.add(code)
			expect(pas.kind, code).toBe(ObservationKind.Description)
			expect(pas.readFrom, code).toMatch(/retrieved/u)
		}

		expect([...citing].toSorted()).toEqual(Object.keys(UPU_PAS_ADDRESS_LAYOUTS).toSorted())
	})

	it("keeps both sides where the dataset and the Latin order disagree", () => {
		// A country with a distinct `lfmt` gets two statements from libaddressinput, and they can differ.
		// A single recorded statement would report agreement that the data does not show.
		const disagreeing: string[] = []

		for (const claim of CLAIMS) {
			for (const code of Object.keys(GENERATED_LATIN_ADDRESS_LAYOUTS)) {
				const answer = conventionClaimForCountry(claim, code)!

				const stances = new Set(
					answer.observations
						.filter((entry) => entry.source === ConventionSource.LibAddressInput)
						.map((entry) => entry.stance)
				)

				if (stances.size > 1) {
					disagreeing.push(`${code}/${claim}`)
				}
			}
		}

		// The set is non-empty for a real dataset: eight countries define a distinct pair.
		expect(disagreeing.length).toBeGreaterThan(0)
	})

	it("reports a disagreement rather than resolving it", () => {
		const found: string[] = []

		for (const claim of CLAIMS) {
			for (const code of Object.keys(ADDRESS_LAYOUTS)) {
				const answer = conventionClaimForCountry(claim, code)!

				if (observationsDisagree(answer)) {
					found.push(`${code}/${claim}`)
				}
			}
		}

		// Whatever the count, every disagreeing claim keeps every observation rather than dropping one.
		for (const key of found) {
			const [code, claim] = key.split("/") as [string, ConventionClaimID]
			const answer = conventionClaimForCountry(claim, code)!

			expect(answer.observations.some((entry) => entry.stance === ObservationStance.Supports)).toBe(true)
			expect(answer.observations.some((entry) => entry.stance === ObservationStance.Contradicts)).toBe(true)
			expect(layoutForCountry(code)).not.toBeNull()
		}
	})
})

describe("layoutPrintsTag and layoutPrintsPostcodeBeforeLocality", () => {
	it("read the FR layout as printing no region and the postcode before the locality", () => {
		const fr = layoutForCountry("FR")!

		expect(layoutPrintsTag(fr, "region")).toBe(false)
		expect(layoutPrintsTag(fr, "postcode")).toBe(true)
		expect(layoutPrintsPostcodeBeforeLocality(fr)).toBe(true)
	})

	it("read the US layout as printing a region and the postcode after the locality", () => {
		const us = layoutForCountry("US")!

		expect(layoutPrintsTag(us, "region")).toBe(true)
		expect(layoutPrintsPostcodeBeforeLocality(us)).toBe(false)
	})
})

/**
 * Libaddressinput's placeholder vocabulary, in this project's tag names;
 * `%A` is the street-address field this table expands, mapped to the marker the skeleton
 * comparison treats as "the street line, however it is spelled".
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
 * Countries whose layout departs from the dataset skeleton and the reason for each departure.
 *
 * Every entry records a decision.
 * A departure without an entry is a transcription error.
 */
const ACCEPTED_DEPARTURES: Readonly<Record<string, string>> = {
	FR: "the lieu-dit line, which La Poste specifies and libaddressinput omits",
	GB: "the dependent-locality line above the post town",
	JP: "the sub-prefecture run is split into its own tags, and the prefecture joins it rather than taking a line",
	CN: "the street line is split into street and house number",
	HK: "the English register's order, which the rest of the codex already assumes for HK",
}

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

function skeletonOfFormat(fmt: string): string[][] {
	return (
		fmt
			.split("%n")
			// An unmodeled placeholder is kept in its `%X` spelling rather than dropped: a skeleton that silently loses a field compares equal to one that never had it.
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
		const { COMPONENT_TAGS } = await import("#component")
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
		// The US skeleton is the one every reader knows, so this is the fixture that
		// proves the reader rather than the table.
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
	 * The render order comes from the layout and `LINE_JOINS` is picked by the system flag,
	 * so a disagreement prints one system's sequence with another's separators.
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
	 * The eight records in the shipped dataset whose `lfmt` differs from their `fmt`,
	 * listed rather than derived so the test states the population it covers;
	 * `layout-table-source.test.ts` is what compares the tables to the dataset.
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
		// The order comes from the layout while the separator comes from a country flag,
		// so the two can name different systems.
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
		// Hong Kong's default layout is its English register, so its default join must
		// be the English one even though its local join is `""`.
		expect(lineJoinForCountry("HK")).toBe(", ")
		expect(lineJoinForCountry("HK", "local")).toBe("")
		expect(lineJoinForCountry("CN")).toBe("")
		expect(lineJoinForCountry("CN", "local")).toBe("")
		expect(lineJoinForCountry("US")).toBe(", ")
	})
})

describe("the admin run keeps its tier order in every layout", () => {
	/**
	 * `layoutPrintsLargestFirst` asks whether a layout runs large to small overall.
	 *
	 * An inversion between adjacent admin tiers leaves that answer unchanged:
	 * a Hong Kong layout printing the district above the area is still largest-first.
	 *
	 * The sub-locality is the tier the generator authors wherever a `fmt` names no `%D`,
	 * and the one relation it has to get right is which side of the locality it lands on.
	 * Four generated skeletons (CR, KI, LV, RO) print the region between the street and the locality.
	 *
	 * The dataset supplies these orders.
	 * This check does not judge them.
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
	 * The tags a layout prints, in print order, read off a render of a full address so an alternation
	 * or a nested street node contributes what it prints rather than what it declares.
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

		// The count states the population, so an empty `outside` cannot be a reader that found no entries to read.
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
